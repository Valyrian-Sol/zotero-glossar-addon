/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils */
"use strict";

const PREF_STORE_KEY = "extensions.pdf-definitions.store";
const PREF_SUBTLE_HINT_KEY = "extensions.pdf-definitions.subtleHint";
const PREF_THEME_KEY = "extensions.pdf-definitions.theme"; // "auto" | "dark" | "light"

/**
 * Hebt Xray-Waiver (`wrappedJSObject` / `WaivedXrayWrapper`) für DOM-Knoten, Windows oder Promises wieder auf,
 * damit Standard-DOM-APIs (`addEventListener`, `createElement`, `getBoundingClientRect` usw.)
 * ohne SpiderMonkey-Permission-Denied-Fehler aufgerufen werden können.
 */
function unwaive(obj) {
  if (!obj) return obj;
  try {
    if (typeof Components !== "undefined" && Components.utils?.unwaiveXrays) {
      return Components.utils.unwaiveXrays(obj);
    }
  } catch (_) {}
  return obj;
}

/**
 * Liefert das `wrappedJSObject` (WaivedXrayWrapper) eines Content-Objekts, um auf benutzerdefinierte
 * JS-Properties (wie `PDFViewerApplication`, `_pdfPages`, `_pages` usw.) zuzugreifen.
 */
function waive(obj) {
  if (!obj) return obj;
  try {
    if (obj.wrappedJSObject) return obj.wrappedJSObject;
    if (typeof Components !== "undefined" && Components.utils?.waiveXrays) {
      return Components.utils.waiveXrays(obj);
    }
  } catch (_) {}
  return obj;
}

/**
 * Wartet sicher auf ein Promise aus einem Content-Compartment (`WaivedXrayWrapper`), indem
 * `resolve`/`reject`-Callbacks per `Components.utils.exportFunction` in den Content-Scope exportiert werden.
 */
function awaitContentPromise(thenable, contentWin) {
  if (!thenable) return Promise.resolve(undefined);
  try {
    if (
      contentWin &&
      typeof Components !== "undefined" &&
      typeof Components.utils?.exportFunction === "function" &&
      typeof thenable.then === "function"
    ) {
      const targetScope = unwaive(contentWin);
      return new Promise((resolve, reject) => {
        const resFn = Components.utils.exportFunction((val) => resolve(val), targetScope);
        const rejFn = Components.utils.exportFunction((err) => reject(err), targetScope);
        thenable.then(resFn, rejFn);
      });
    }
  } catch (_) {}
  try {
    const clean = unwaive(thenable);
    if (clean && typeof clean.then === "function") {
      return Promise.resolve(clean);
    }
  } catch (_) {}
  return Promise.resolve(thenable);
}

/**
 * Transformiert ein PDF-Rechteck `[x1, y1, x2, y2]` mithilfe von `viewport.transform` (`[m0..m5]`)
 * direkt in Viewport-Koordinaten, ohne ein System-Principal-Array an ein Waived-Content-Objekt
 * übergeben zu müssen (`Permission denied to access property 0`).
 */
function convertPdfRectToViewport(viewport, pdfRect) {
  if (!viewport || !pdfRect || typeof pdfRect.length !== "number" || pdfRect.length < 4) {
    return null;
  }
  const tr = viewport.transform;
  if (tr && typeof tr.length === "number" && tr.length >= 6) {
    const m0 = Number(tr[0]);
    const m1 = Number(tr[1]);
    const m2 = Number(tr[2]);
    const m3 = Number(tr[3]);
    const m4 = Number(tr[4]);
    const m5 = Number(tr[5]);
    if (
      !Number.isNaN(m0) &&
      !Number.isNaN(m1) &&
      !Number.isNaN(m2) &&
      !Number.isNaN(m3) &&
      !Number.isNaN(m4) &&
      !Number.isNaN(m5)
    ) {
      const x1 = Number(pdfRect[0]) * m0 + Number(pdfRect[1]) * m2 + m4;
      const y1 = Number(pdfRect[0]) * m1 + Number(pdfRect[1]) * m3 + m5;
      const x2 = Number(pdfRect[2]) * m0 + Number(pdfRect[3]) * m2 + m4;
      const y2 = Number(pdfRect[2]) * m1 + Number(pdfRect[3]) * m3 + m5;
      return [x1, y1, x2, y2];
    }
  }
  if (typeof viewport.convertToViewportRectangle === "function") {
    try {
      return viewport.convertToViewportRectangle(pdfRect);
    } catch (_) {}
  }
  return null;
}

/**
 * Normalisiert Whitespace innerhalb eines Ausdrucks (mehrere Leerzeichen/Zeilenumbrüche -> ein Leerzeichen).
 */
function normalizeWhitespace(str) {
  return String(str || "").replace(/\s+/gu, " ").trim();
}

/**
 * Prüft, ob ein Zeichen ein Wortzeichen (Buchstabe, Zahl, Unterstrich) ist.
 */
function isWordChar(ch) {
  if (!ch) return false;
  return /[\p{L}\p{N}_]/u.test(ch);
}

/**
 * Intelligente Standardwerte für einen neu ausgewählten Begriff:
 * - Kurze Ausdrücke (1-3 Zeichen, z. B. Buchstaben/Variablen wie "E", "α", "k") oder
 *   Ausdrücke mit Großbuchstaben im Inneren (z. B. "pH", "LaTeX") sind standardmäßig case-sensitive.
 * - Reine Wort-Ausdrücke >= 2 Zeichen nutzen standardmäßig Wortgrenzen (wholeWord = true),
 *   Einzelbuchstaben oder Ausdrücke mit Sonderzeichen/Mathe-Symbolen wholeWord = false.
 */
function inferDefaultMatchOptions(term) {
  const clean = normalizeWhitespace(term);
  const isShort = clean.length <= 3;
  const hasInternalUpper = clean.length > 1 && /[A-ZÄÖÜ]/.test(clean.slice(1));
  const caseSensitive = isShort || hasInternalUpper;

  const startsAndEndsWithWord =
    clean.length >= 1 &&
    isWordChar(clean[0]) &&
    isWordChar(clean[clean.length - 1]);
  const wholeWord = startsAndEndsWithWord;

  return { caseSensitive, wholeWord };
}

/**
 * Baut aus Zoteros `pdfPages[pageIndex].chars`-Array einen durchsuchbaren String
 * sowie ein Mapping `charIdxMap`, das für jede String-Position den Index in `chars` speichert.
 */
function buildSearchableTextFromChars(chars) {
  if (!chars || typeof chars.length !== "number" || chars.length === 0) {
    return { text: "", charIdxMap: [] };
  }
  const outChars = [];
  const charIdxMap = [];

  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i];
    if (!ch || ch.ignorable) continue;

    const c = typeof ch.u === "string" && ch.u.length > 0 ? ch.u : ch.c;
    if (typeof c === "string" && c.length > 0) {
      for (let k = 0; k < c.length; k++) {
        outChars.push(c[k]);
        charIdxMap.push(i);
      }
    }

    if (ch.spaceAfter || ch.lineBreakAfter || ch.paragraphBreakAfter) {
      if (outChars.length > 0 && outChars[outChars.length - 1] !== " ") {
        outChars.push(" ");
        charIdxMap.push(i);
      }
    }
  }

  return {
    text: outChars.join(""),
    charIdxMap,
  };
}

/**
 * Berechnet zeilenweise PDF-Rechtecke [x1, y1, x2, y2] für eine Teilmenge von `chars`
 * (analog zu Zoteros internem `getRectsFromChars`).
 */
function computeRectsFromCharsSlice(charsSlice) {
  const lineRects = [];
  let currentLineRect = null;
  if (!charsSlice || typeof charsSlice.length !== "number") return lineRects;

  for (let i = 0; i < charsSlice.length; i++) {
    const ch = charsSlice[i];
    if (!ch || ch.ignorable) continue;
    const r = ch.inlineRect || ch.rect;
    if (!r || typeof r.length !== "number" || r.length < 4) continue;
    const r0 = Number(r[0]);
    const r1 = Number(r[1]);
    const r2 = Number(r[2]);
    const r3 = Number(r[3]);

    if (!currentLineRect) {
      currentLineRect = [r0, r1, r2, r3];
    } else {
      currentLineRect = [
        Math.min(currentLineRect[0], r0),
        Math.min(currentLineRect[1], r1),
        Math.max(currentLineRect[2], r2),
        Math.max(currentLineRect[3], r3),
      ];
    }

    if (ch.lineBreakAfter) {
      lineRects.push(currentLineRect);
      currentLineRect = null;
    }
  }

  if (currentLineRect) {
    lineRects.push(currentLineRect);
  }
  return lineRects;
}

/**
 * Sucht alle Vorkommen der aktiven Definitionen innerhalb eines `chars`-Arrays einer PDF-Seite.
 */
function findMatchesInPageChars(chars, definitions) {
  if (
    !chars ||
    typeof chars.length !== "number" ||
    !chars.length ||
    !Array.isArray(definitions) ||
    !definitions.length
  ) {
    return [];
  }

  const { text, charIdxMap } = buildSearchableTextFromChars(chars);
  if (!text) return [];

  const textLower = text.toLowerCase();
  const matches = [];

  // Längere Begriffe zuerst prüfen, spezifische PDF-Definitionen vor globalen bei gleichem Begriff
  const sortedDefs = definitions.slice().sort((a, b) => {
    const lenDiff = (b.term?.length || 0) - (a.term?.length || 0);
    if (lenDiff !== 0) return lenDiff;
    if (a.scope !== b.scope) return a.scope === "pdf" ? -1 : 1;
    return 0;
  });

  for (const def of sortedDefs) {
    const needleRaw = normalizeWhitespace(def.term);
    if (!needleRaw) continue;

    const caseSensitive = Boolean(def.caseSensitive);
    const wholeWord = Boolean(def.wholeWord);
    const haystack = caseSensitive ? text : textLower;
    const needle = caseSensitive ? needleRaw : needleRaw.toLowerCase();
    const nLen = needle.length;
    if (nLen === 0) continue;

    let pos = 0;
    while (pos <= haystack.length - nLen) {
      const idx = haystack.indexOf(needle, pos);
      if (idx === -1) break;

      const endIdx = idx + nLen;
      let boundaryOk = true;

      if (wholeWord) {
        const prevChar = idx > 0 ? text[idx - 1] : "";
        const nextChar = endIdx < text.length ? text[endIdx] : "";
        if (nLen === 1) {
          // Einzelbuchstaben/Symbole (z. B. "E", "α") nicht mitten in Wörtern ("Energie") matchen,
          // aber in Ausdrücken wie "2α", "E_0" oder "(E)" erlauben:
          if (/\p{L}/u.test(prevChar) || /\p{L}/u.test(nextChar)) {
            boundaryOk = false;
          }
        } else if (isWordChar(prevChar) || isWordChar(nextChar)) {
          boundaryOk = false;
        }
      }

      if (boundaryOk) {
        const startCharIndex = charIdxMap[idx];
        const endCharIndex = charIdxMap[endIdx - 1];
        if (startCharIndex !== undefined && endCharIndex !== undefined && endCharIndex >= startCharIndex) {
          const slice = [];
          for (let cIdx = startCharIndex; cIdx <= endCharIndex; cIdx++) {
            slice.push(chars[cIdx]);
          }
          const rects = computeRectsFromCharsSlice(slice);
          if (rects.length > 0) {
            matches.push({
              def,
              startCharIndex,
              endCharIndex,
              rects,
            });
          }
        }
      }

      pos = idx + 1;
    }
  }

  return matches;
}

class ZoteroPDFDefinitions {
  constructor({ id, version, rootURI }) {
    this.id = id;
    this.version = version;
    this.rootURI = rootURI;
    this.definitions = [];
    this.subtleHint = true;
    this.themeMode = "auto"; // "auto" | "dark" | "light"
    this._defsStamp = 1;
    this._saveTimer = null;
    this._readerPollInterval = null;
    this._hookedReaders = new WeakSet();
    this._hookedPdfViews = new WeakSet();
  }

  log(msg) {
    try {
      Zotero.debug(`[PDF-Definitions] ${msg}`);
    } catch (_) {}
  }

  getBackupFilePath() {
    try {
      return PathUtils.join(Zotero.Profile.dir, "pdf-definitions-glossary.json");
    } catch (_) {
      return null;
    }
  }

  async loadStore() {
    try {
      const subtlePref = Zotero.Prefs.get(PREF_SUBTLE_HINT_KEY, true);
      if (typeof subtlePref === "boolean") {
        this.subtleHint = subtlePref;
      }
      const themePref = Zotero.Prefs.get(PREF_THEME_KEY, true);
      if (themePref === "auto" || themePref === "dark" || themePref === "light") {
        this.themeMode = themePref;
      }
    } catch (_) {}

    let loaded = null;
    try {
      const raw = Zotero.Prefs.get(PREF_STORE_KEY, true);
      if (raw && typeof raw === "string") {
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          loaded = parsed;
        } else if (parsed && Array.isArray(parsed.definitions)) {
          loaded = parsed.definitions;
          if (
            !Zotero.Prefs.get(PREF_THEME_KEY, true) &&
            (parsed.themeMode === "auto" ||
              parsed.themeMode === "dark" ||
              parsed.themeMode === "light")
          ) {
            this.themeMode = parsed.themeMode;
          }
        }
      }
    } catch (err) {
      this.log(`Konnte Pref-Store nicht parsen: ${err}`);
    }

    if (!loaded) {
      const backupPath = this.getBackupFilePath();
      if (backupPath) {
        try {
          if (await IOUtils.exists(backupPath)) {
            const rawFile = await IOUtils.readUTF8(backupPath);
            const parsed = JSON.parse(rawFile);
            if (Array.isArray(parsed)) {
              loaded = parsed;
            } else if (parsed && Array.isArray(parsed.definitions)) {
              loaded = parsed.definitions;
              if (
                parsed.themeMode === "auto" ||
                parsed.themeMode === "dark" ||
                parsed.themeMode === "light"
              ) {
                this.themeMode = parsed.themeMode;
              }
              if (typeof parsed.subtleHint === "boolean") {
                this.subtleHint = parsed.subtleHint;
              }
            }
          }
        } catch (err) {
          this.log(`Konnte Backup-Datei nicht lesen: ${err}`);
        }
      }
    }

    this.definitions = Array.isArray(loaded) ? loaded : [];
    this._defsStamp = (this._defsStamp || 0) + 1;
    this.log(`${this.definitions.length} Definition(en) geladen (Theme: ${this.themeMode}).`);
  }

  saveStore() {
    const payload = JSON.stringify({
      version: 1,
      updatedAt: new Date().toISOString(),
      themeMode: this.themeMode || "auto",
      subtleHint: Boolean(this.subtleHint),
      definitions: this.definitions,
    });

    try {
      Zotero.Prefs.set(PREF_STORE_KEY, payload, true);
      Zotero.Prefs.set(PREF_SUBTLE_HINT_KEY, Boolean(this.subtleHint), true);
      Zotero.Prefs.set(PREF_THEME_KEY, this.themeMode || "auto", true);
    } catch (err) {
      this.log(`Fehler beim Speichern in Zotero.Prefs: ${err}`);
    }

    const backupPath = this.getBackupFilePath();
    if (backupPath) {
      IOUtils.writeUTF8(backupPath, payload).catch((err) => {
        this.log(`Fehler beim Schreiben des JSON-Backups: ${err}`);
      });
    }
  }

  /**
   * Erkennt, ob Zoteros Reader-Oberfläche aktuell im Darkmode oder Lightmode läuft.
   */
  detectHostTheme(reader) {
    try {
      const rWin = reader?._iframeWindow;
      const doc = rWin?.document;
      if (doc?.documentElement) {
        const attr =
          doc.documentElement.getAttribute("data-color-scheme") ||
          doc.body?.getAttribute("data-color-scheme") ||
          "";
        if (attr === "dark") return "dark";
        if (attr === "light") return "light";
      }
      if (rWin?.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
        return "dark";
      }
      const mainWin = typeof Zotero !== "undefined" ? Zotero.getMainWindow?.() : null;
      if (mainWin?.matchMedia?.("(prefers-color-scheme: dark)")?.matches) {
        return "dark";
      }
    } catch (_) {}
    return "light";
  }

  /**
   * Liefert das effektiv anzuwendende Farbschema ("dark" | "light") für einen Reader.
   */
  resolveEffectiveTheme(reader) {
    if (this.themeMode === "dark") return "dark";
    if (this.themeMode === "light") return "light";
    return this.detectHostTheme(reader);
  }

  /**
   * Berechnet den nächsten Theme-Modus beim Klick auf den Schnell-Umschalter,
   * sodass bereits der erste Klick immer einen sofort sichtbaren Wechsel bewirkt.
   */
  getNextThemeMode(reader) {
    if (this.themeMode === "auto") {
      const currentEffective = this.detectHostTheme(reader);
      return currentEffective === "dark" ? "light" : "dark";
    }
    if (this.themeMode === "dark") {
      const host = this.detectHostTheme(reader);
      return host === "dark" ? "auto" : "light";
    }
    // this.themeMode === "light"
    const host = this.detectHostTheme(reader);
    return host === "light" ? "auto" : "dark";
  }

  getThemeButtonMeta(reader) {
    const effective = this.resolveEffectiveTheme(reader);
    if (this.themeMode === "dark") {
      return {
        label: "🌙 Dark",
        title: "Design: Darkmode aktiv (Klicken zum Wechseln)",
      };
    }
    if (this.themeMode === "light") {
      return {
        label: "☀️ Hell",
        title: "Design: Lightmode aktiv (Klicken zum Wechseln)",
      };
    }
    return {
      label: effective === "dark" ? "🌓 Auto" : "🌓 Auto",
      title: `Design: Automatisch (${
        effective === "dark" ? "Darkmode erkannt" : "Lightmode erkannt"
      }) – Klicken zum Umschalten`,
    };
  }

  setThemeMode(mode) {
    if (mode !== "auto" && mode !== "dark" && mode !== "light") return;
    this.themeMode = mode;
    this.saveStore();
    this.applyThemeToAllReaders();
  }

  applyThemeToAllReaders() {
    const readers = Zotero.Reader?._readers || [];
    for (const reader of readers) {
      if (!reader || reader.type !== "pdf" || !reader._iframeWindow) continue;
      this.applyThemeToReader(reader);
    }
  }

  applyThemeToReader(reader) {
    try {
      const rWin = reader?._iframeWindow;
      const doc = rWin?.document;
      if (!doc?.documentElement) return;

      const hostTheme = this.detectHostTheme(reader);
      const effectiveTheme = this.resolveEffectiveTheme(reader);

      doc.documentElement.setAttribute("data-zpdf-theme", effectiveTheme);
      doc.documentElement.setAttribute("data-zpdf-theme-mode", this.themeMode || "auto");
      if (effectiveTheme !== hostTheme) {
        doc.documentElement.setAttribute("data-zpdf-contrast-card", "true");
      } else {
        doc.documentElement.removeAttribute("data-zpdf-contrast-card");
      }

      // Auch auf die inneren PDF.js-Dokumente spiegeln
      const internalReader = waive(reader._internalReader);
      const views = [internalReader?._primaryView, internalReader?._secondaryView].filter(
        Boolean
      );
      for (let i = 0; i < views.length; i++) {
        const uw = waive(views[i]);
        const pWin = unwaive(uw?._iframeWindow);
        const pDoc = unwaive(pWin?.document);
        if (pDoc?.documentElement) {
          pDoc.documentElement.setAttribute("data-zpdf-theme", effectiveTheme);
        }
      }

      // Live-Beobachter für Zotero-Farbschema-Wechsel einmalig registrieren
      if (!doc._zpdfThemeObserver && typeof rWin.MutationObserver === "function") {
        const obs = new rWin.MutationObserver(() => {
          if (this.themeMode === "auto") {
            this.applyThemeToReader(reader);
          } else {
            const newHost = this.detectHostTheme(reader);
            const eff = this.resolveEffectiveTheme(reader);
            if (eff !== newHost) {
              doc.documentElement.setAttribute("data-zpdf-contrast-card", "true");
            } else {
              doc.documentElement.removeAttribute("data-zpdf-contrast-card");
            }
          }
        });
        obs.observe(doc.documentElement, {
          attributes: true,
          attributeFilter: ["data-color-scheme"],
        });
        doc._zpdfThemeObserver = obs;

        const mql = rWin.matchMedia?.("(prefers-color-scheme: dark)");
        if (mql?.addEventListener) {
          const onMqlChange = () => this.applyThemeToReader(reader);
          mql.addEventListener("change", onMqlChange);
          doc._zpdfMqlCleanup = () => mql.removeEventListener("change", onMqlChange);
        }
      }
    } catch (err) {
      this.log(`applyThemeToReader Fehler: ${err}`);
    }
  }

  /**
   * Eindeutiger Dokument-Schlüssel für das aktuell geöffnete PDF-Item.
   */
  getDocKey(reader) {
    try {
      const item = reader?._item || (reader?.itemID ? Zotero.Items.get(reader.itemID) : null);
      if (item) {
        return `${item.libraryID || 1}:${item.key}`;
      }
      if (reader?.itemID) {
        return `item:${reader.itemID}`;
      }
    } catch (_) {}
    return "unknown-doc";
  }

  getDocTitle(reader) {
    try {
      const item = reader?._item || (reader?.itemID ? Zotero.Items.get(reader.itemID) : null);
      if (item) {
        const parent = item.parentItem;
        if (parent) {
          return parent.getDisplayTitle() || item.getDisplayTitle() || "PDF";
        }
        return item.getDisplayTitle() || "PDF";
      }
    } catch (_) {}
    return reader?._title || "PDF";
  }

  /**
   * Liefert alle Definitionen, die für `docKey` aktiv sind (PDF-spezifische + globale).
   */
  getActiveDefinitionsForDoc(docKey) {
    return this.definitions.filter(
      (d) => d.scope === "global" || (d.scope === "pdf" && d.docKey === docKey)
    );
  }

  /**
   * Sucht eine bestehende Definition für denselben Begriff (bevorzugt im aktuellen PDF, sonst global).
   */
  findDefinitionForTerm(term, docKey) {
    const clean = normalizeWhitespace(term);
    if (!clean) return null;
    const cleanLower = clean.toLowerCase();

    const active = this.getActiveDefinitionsForDoc(docKey);
    // Zuerst exakter Treffer im PDF, dann global, danach case-insensitiver Treffer
    return (
      active.find((d) => d.scope === "pdf" && normalizeWhitespace(d.term) === clean) ||
      active.find((d) => d.scope === "global" && normalizeWhitespace(d.term) === clean) ||
      active.find(
        (d) =>
          !d.caseSensitive &&
          d.scope === "pdf" &&
          normalizeWhitespace(d.term).toLowerCase() === cleanLower
      ) ||
      active.find(
        (d) =>
          !d.caseSensitive &&
          d.scope === "global" &&
          normalizeWhitespace(d.term).toLowerCase() === cleanLower
      ) ||
      null
    );
  }

  /**
   * Prüft umfassend, ob ein Ausdruck bereits definiert wurde:
   * - `localMatch`: bereits im aktuellen PDF (`docKey`) definiert
   * - `globalMatch`: bereits global für alle PDFs definiert
   * - `otherPdfMatches`: bereits lokal in anderen PDFs definiert
   */
  findConflictsForTerm(term, docKey, excludeId = null) {
    const clean = normalizeWhitespace(term);
    if (!clean) {
      return { localMatch: null, globalMatch: null, otherPdfMatches: [] };
    }
    const cleanLower = clean.toLowerCase();

    const matchesTerm = (d) => {
      if (excludeId && d.id === excludeId) return false;
      const dTerm = normalizeWhitespace(d.term);
      if (!dTerm) return false;
      if (dTerm === clean) return true;
      // Bei Wörtern/Wortgruppen (> 1 Zeichen) immer auch case-insensitiv warnen;
      // bei Einzelbuchstaben (z. B. "E" vs. "e") nur wenn nicht caseSensitive:
      if (clean.length > 1 && dTerm.length > 1) {
        return dTerm.toLowerCase() === cleanLower;
      }
      if (!d.caseSensitive) {
        return dTerm.toLowerCase() === cleanLower;
      }
      return false;
    };

    const localMatch =
      this.definitions.find(
        (d) =>
          d.scope === "pdf" &&
          d.docKey === docKey &&
          d.id !== excludeId &&
          normalizeWhitespace(d.term) === clean
      ) ||
      this.definitions.find(
        (d) => d.scope === "pdf" && d.docKey === docKey && matchesTerm(d)
      ) ||
      null;

    const globalMatch =
      this.definitions.find(
        (d) =>
          d.scope === "global" &&
          d.id !== excludeId &&
          normalizeWhitespace(d.term) === clean
      ) ||
      this.definitions.find((d) => d.scope === "global" && matchesTerm(d)) ||
      null;

    const otherPdfMatches = this.definitions.filter(
      (d) => d.scope === "pdf" && d.docKey !== docKey && matchesTerm(d)
    );

    return { localMatch, globalMatch, otherPdfMatches };
  }

  /**
   * Speichert oder aktualisiert eine Definition und aktualisiert sofort alle offenen PDF-Reader.
   */
  upsertDefinition({ id, term, definition, scope, docKey, docTitle, caseSensitive, wholeWord }) {
    const cleanTerm = normalizeWhitespace(term);
    const cleanDef = String(definition || "").trim();
    if (!cleanTerm || !cleanDef) return null;

    const targetScope = scope === "global" ? "global" : "pdf";
    const targetDocKey = targetScope === "pdf" ? docKey : null;

    let existing = null;
    if (id) {
      existing = this.definitions.find((d) => d.id === id);
    }
    if (!existing) {
      existing = this.definitions.find(
        (d) =>
          d.scope === targetScope &&
          (targetScope === "global" || d.docKey === targetDocKey) &&
          (caseSensitive
            ? normalizeWhitespace(d.term) === cleanTerm
            : normalizeWhitespace(d.term).toLowerCase() === cleanTerm.toLowerCase())
      );
    }

    const now = new Date().toISOString();
    if (existing) {
      existing.term = cleanTerm;
      existing.definition = cleanDef;
      existing.scope = targetScope;
      existing.docKey = targetDocKey;
      if (docTitle) existing.docTitle = docTitle;
      existing.caseSensitive = Boolean(caseSensitive);
      existing.wholeWord = Boolean(wholeWord);
      existing.updatedAt = now;
    } else {
      existing = {
        id: id || `def_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        term: cleanTerm,
        definition: cleanDef,
        scope: targetScope,
        docKey: targetDocKey,
        docTitle: docTitle || "PDF",
        caseSensitive: Boolean(caseSensitive),
        wholeWord: Boolean(wholeWord),
        createdAt: now,
        updatedAt: now,
      };
      this.definitions.push(existing);
    }

    this._defsStamp = (this._defsStamp || 0) + 1;
    this.saveStore();
    this.refreshAllReaders();
    return existing;
  }

  deleteDefinition(id) {
    const before = this.definitions.length;
    this.definitions = this.definitions.filter((d) => d.id !== id);
    if (this.definitions.length !== before) {
      this._defsStamp = (this._defsStamp || 0) + 1;
      this.saveStore();
      this.refreshAllReaders();
      return true;
    }
    return false;
  }

  async startup() {
    await Zotero.initializationPromise;
    await this.loadStore();

    this._onRenderPopup = (event) => this.onRenderTextSelectionPopup(event);
    this._onRenderToolbar = (event) => this.onRenderToolbar(event);
    this._onContextMenu = (event) => this.onCreateViewContextMenu(event);

    // 1. TextSelectionPopup: Beim Markieren eines Ausdrucks/Buchstabens/Wortgruppe im PDF
    Zotero.Reader.registerEventListener(
      "renderTextSelectionPopup",
      this._onRenderPopup,
      this.id
    );

    // 2. Toolbar-Button im PDF-Reader für die Glossar-Übersicht & Einstellungen
    Zotero.Reader.registerEventListener(
      "renderToolbar",
      this._onRenderToolbar,
      this.id
    );

    // 3. Rechtsklick-Kontextmenü im PDF-Reader
    Zotero.Reader.registerEventListener(
      "createViewContextMenu",
      this._onContextMenu,
      this.id
    );

    // 4. Bereits geöffnete und neu hinzukommende Reader-Tabs überwachen
    this.scanOpenReaders();
    const mainWindow = Zotero.getMainWindow();
    if (mainWindow) {
      this._readerPollInterval = mainWindow.setInterval(() => {
        this.scanOpenReaders();
      }, 1200);
    }
  }

  async shutdown() {
    try {
      if (Zotero.Reader?.unregisterEventListener) {
        if (this._onRenderPopup) {
          Zotero.Reader.unregisterEventListener("renderTextSelectionPopup", this._onRenderPopup);
        }
        if (this._onRenderToolbar) {
          Zotero.Reader.unregisterEventListener("renderToolbar", this._onRenderToolbar);
        }
        if (this._onContextMenu) {
          Zotero.Reader.unregisterEventListener("createViewContextMenu", this._onContextMenu);
        }
      }
    } catch (_) {}

    try {
      const mainWindow = Zotero.getMainWindow();
      if (mainWindow && this._readerPollInterval) {
        mainWindow.clearInterval(this._readerPollInterval);
        this._readerPollInterval = null;
      }
    } catch (_) {}

    try {
      for (const reader of Zotero.Reader._readers || []) {
        this.cleanupReaderDOM(reader);
      }
    } catch (_) {}
  }

  onMainWindowLoad(_window) {
    this.scanOpenReaders();
  }

  onMainWindowUnload(_window) {}

  /**
   * Injiziert unser CSS (inkl. Lightmode- & Darkmode-Variablen) und die schwebende
   * Tooltip-/Dialog-Infrastruktur in `reader._iframeWindow.document`.
   */
  ensureReaderUI(reader) {
    const rWin = reader?._iframeWindow;
    if (!rWin || !rWin.document || !rWin.document.head || !rWin.document.body) {
      return null;
    }
    const doc = rWin.document;
    this.applyThemeToReader(reader);

    let style = doc.getElementById("zpdf-def-styles");
    const isNewStyle = !style;
    if (isNewStyle) {
      style = doc.createElement("style");
      style.id = "zpdf-def-styles";
    }
    const styleVer = this.version || "1.0.6";
    if (isNewStyle || style.dataset?.zpdfVersion !== styleVer) {
      if (style.dataset) {
        style.dataset.zpdfVersion = styleVer;
      }
      style.textContent = `
        :root {
          --zpdf-color-scheme: light;
          --zpdf-bg: #ffffff;
          --zpdf-surface: #f8fafc;
          --zpdf-surface-subtle: #f1f5f9;
          --zpdf-input-bg: #ffffff;
          --zpdf-fg: #0f172a;
          --zpdf-fg-muted: #64748b;
          --zpdf-border: #cbd5e1;
          --zpdf-border-subtle: rgba(100, 116, 139, 0.28);
          --zpdf-header-fg: #4338ca;
          --zpdf-accent: #4f46e5;
          --zpdf-accent-hover: #4338ca;
          --zpdf-accent-soft: rgba(79, 70, 229, 0.1);
          --zpdf-btn-sec-bg: #e2e8f0;
          --zpdf-btn-sec-fg: #1e293b;
          --zpdf-btn-sec-hover: #cbd5e1;
          --zpdf-danger: #dc2626;
          --zpdf-danger-hover: #b91c1c;
          --zpdf-success: #059669;
          --zpdf-warning: #d97706;
          --zpdf-warn-bg: rgba(245, 158, 11, 0.12);
          --zpdf-warn-border: #f59e0b;
          --zpdf-warn-title: #b45309;
          --zpdf-warn-fg: #78350f;
          --zpdf-badge-global-bg: rgba(2, 132, 199, 0.14);
          --zpdf-badge-global-fg: #0369a1;
          --zpdf-badge-pdf-bg: rgba(79, 70, 229, 0.14);
          --zpdf-badge-pdf-fg: #4338ca;
          --zpdf-badge-neutral-bg: #e2e8f0;
          --zpdf-badge-neutral-fg: #334155;
          --zpdf-tt-bg: #ffffff;
          --zpdf-tt-fg: #1e293b;
          --zpdf-tt-term: #4338ca;
          --zpdf-tt-border: #cbd5e1;
          --zpdf-tt-shadow: 0 10px 28px rgba(15, 23, 42, 0.18);
          --zpdf-tt-btn-bg: #f1f5f9;
          --zpdf-tt-btn-fg: #334155;
          --zpdf-tt-btn-hover: #e2e8f0;
          --zpdf-tt-danger-fg: #dc2626;
        }

        :root[data-zpdf-theme="dark"] {
          --zpdf-color-scheme: dark;
          --zpdf-bg: #1f1f24;
          --zpdf-surface: #27272e;
          --zpdf-surface-subtle: #32323b;
          --zpdf-input-bg: #16161a;
          --zpdf-fg: #f4f4f6;
          --zpdf-fg-muted: #a1a1aa;
          --zpdf-border: #4b5563;
          --zpdf-border-subtle: rgba(255, 255, 255, 0.14);
          --zpdf-header-fg: #a5b4fc;
          --zpdf-accent: #6366f1;
          --zpdf-accent-hover: #818cf8;
          --zpdf-accent-soft: rgba(99, 102, 241, 0.2);
          --zpdf-btn-sec-bg: #383842;
          --zpdf-btn-sec-fg: #f4f4f6;
          --zpdf-btn-sec-hover: #484854;
          --zpdf-danger: #ef4444;
          --zpdf-danger-hover: #dc2626;
          --zpdf-success: #34d399;
          --zpdf-warning: #fbbf24;
          --zpdf-warn-bg: rgba(251, 191, 36, 0.14);
          --zpdf-warn-border: #f59e0b;
          --zpdf-warn-title: #fcd34d;
          --zpdf-warn-fg: #fef3c7;
          --zpdf-badge-global-bg: rgba(56, 189, 248, 0.2);
          --zpdf-badge-global-fg: #7dd3fc;
          --zpdf-badge-pdf-bg: rgba(129, 140, 248, 0.22);
          --zpdf-badge-pdf-fg: #c7d2fe;
          --zpdf-badge-neutral-bg: #383842;
          --zpdf-badge-neutral-fg: #e4e4e7;
          --zpdf-tt-bg: #18181b;
          --zpdf-tt-fg: #f4f4f5;
          --zpdf-tt-term: #7dd3fc;
          --zpdf-tt-border: #3f3f46;
          --zpdf-tt-shadow: 0 12px 30px rgba(0, 0, 0, 0.55);
          --zpdf-tt-btn-bg: #27272a;
          --zpdf-tt-btn-fg: #e4e4e7;
          --zpdf-tt-btn-hover: #3f3f46;
          --zpdf-tt-danger-fg: #fca5a5;
        }

        /* Zotero .selection-popup Sektion sauber bündig einpassen (keine doppelte Linie, kein Überlaufen) */
        .selection-popup .custom-sections,
        .selection-popup .custom-sections .section {
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
        }
        .selection-popup .custom-sections .section:has(.zpdf-selection-box) {
          border-top: 1px solid var(--zpdf-border-subtle) !important;
          padding: 6px 0 0 0 !important;
          margin: 0 !important;
        }

        .zpdf-selection-box,
        .zpdf-selection-box.label-popup.preview-popup {
          position: static !important;
          left: auto !important;
          top: auto !important;
          display: flex !important;
          flex-direction: column !important;
          gap: 6px !important;
          width: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          max-height: none !important;
          box-sizing: border-box !important;
          padding: 2px 0 0 0 !important;
          margin: 0 !important;
          border: none !important;
          background: transparent !important;
          box-shadow: none !important;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12px;
          color: var(--zpdf-fg);
          color-scheme: var(--zpdf-color-scheme);
          -moz-user-select: text !important;
          user-select: text !important;
        }
        .zpdf-selection-box.label-popup.preview-popup::before,
        .zpdf-selection-box.label-popup.preview-popup::after {
          display: none !important;
          content: none !important;
        }

        /* Falls der Nutzer manuell Lightmode in einem dunklen Zotero-Popup erzwingt (oder umgekehrt) */
        :root[data-zpdf-contrast-card="true"] .zpdf-selection-box,
        :root[data-zpdf-contrast-card="true"] .zpdf-selection-box.label-popup.preview-popup {
          background: var(--zpdf-bg) !important;
          padding: 7px !important;
          border-radius: 6px !important;
          border: 1px solid var(--zpdf-border) !important;
        }

        .zpdf-selection-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 4px;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .zpdf-selection-title {
          font-weight: 600;
          font-size: 11.5px;
          color: var(--zpdf-header-fg);
          overflow: hidden;
          text-overflow: ellipsis;
          white-space: nowrap;
        }
        .zpdf-theme-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 3px;
          flex-shrink: 0;
          padding: 2px 6px;
          border-radius: 999px;
          border: 1px solid var(--zpdf-border);
          background: var(--zpdf-surface-subtle);
          color: var(--zpdf-fg);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 10px;
          font-weight: 600;
          line-height: 1.2;
          cursor: pointer;
          user-select: none;
        }
        .zpdf-theme-btn:hover {
          border-color: var(--zpdf-accent);
          background: var(--zpdf-accent-soft);
        }

        .zpdf-existing-preview {
          background: var(--zpdf-accent-soft);
          border-left: 3px solid var(--zpdf-accent);
          color: var(--zpdf-fg);
          padding: 5px 7px;
          border-radius: 4px;
          font-size: 11px;
          line-height: 1.35;
          white-space: pre-wrap;
          word-break: break-word;
          box-sizing: border-box;
          width: 100%;
        }

        .zpdf-dup-warning {
          display: flex;
          flex-direction: column;
          gap: 3px;
          width: 100%;
          min-width: 0;
          max-width: 100%;
          box-sizing: border-box;
          padding: 5px 7px;
          border-radius: 5px;
          background: var(--zpdf-warn-bg);
          border: 1px solid rgba(245, 158, 11, 0.45);
          border-left: 3px solid var(--zpdf-warn-border);
          color: var(--zpdf-warn-fg);
          font-size: 11px;
          line-height: 1.3;
          word-break: break-word;
        }
        .zpdf-dup-warning[hidden] {
          display: none !important;
        }
        .zpdf-dup-warning-title {
          font-weight: 700;
          color: var(--zpdf-warn-title);
          display: flex;
          align-items: center;
          gap: 4px;
        }
        .zpdf-dup-warning-preview {
          opacity: 0.94;
          display: -webkit-box;
          -webkit-line-clamp: 3;
          -webkit-box-orient: vertical;
          overflow: hidden;
          white-space: pre-wrap;
        }
        .zpdf-dup-inline-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          align-self: flex-start;
          margin-top: 2px;
          padding: 2px 6px;
          border-radius: 4px;
          border: 1px solid var(--zpdf-warn-border);
          background: transparent;
          color: var(--zpdf-warn-title);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 10px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        }
        .zpdf-dup-inline-btn:hover {
          background: var(--zpdf-warn-bg);
        }

        .zpdf-input,
        .zpdf-textarea {
          display: block;
          width: 100% !important;
          min-width: 0 !important;
          max-width: 100% !important;
          box-sizing: border-box !important;
          margin: 0 !important;
          padding: 5px 7px !important;
          border-radius: 5px !important;
          border: 1px solid var(--zpdf-border) !important;
          background-color: var(--zpdf-input-bg) !important;
          color: var(--zpdf-fg) !important;
          caret-color: var(--zpdf-fg) !important;
          font-family: system-ui, -apple-system, sans-serif !important;
          font-size: 11.5px !important;
          line-height: 1.35 !important;
          color-scheme: var(--zpdf-color-scheme);
        }
        .zpdf-input::placeholder,
        .zpdf-textarea::placeholder {
          color: var(--zpdf-fg-muted) !important;
          opacity: 1 !important;
        }
        .zpdf-input:focus,
        .zpdf-textarea:focus {
          outline: 2px solid var(--zpdf-accent) !important;
          outline-offset: -1px;
          border-color: var(--zpdf-accent) !important;
        }
        .zpdf-textarea {
          min-height: 54px;
          max-height: 150px;
          resize: vertical;
        }

        .zpdf-options-col {
          display: flex;
          flex-direction: column;
          gap: 4px;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
        }
        .zpdf-options-row {
          display: flex;
          flex-wrap: wrap;
          gap: 4px 8px;
          font-size: 11px;
          align-items: center;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          color: var(--zpdf-fg);
        }
        .zpdf-options-row-split {
          justify-content: space-between;
        }
        .zpdf-checkbox-label {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          cursor: pointer;
          user-select: none;
          color: var(--zpdf-fg) !important;
          font-size: 11px;
          line-height: 1.25;
          min-width: 0;
        }
        .zpdf-checkbox-label input[type="checkbox"] {
          margin: 0 !important;
          width: 13px;
          height: 13px;
          flex-shrink: 0;
          cursor: pointer;
          accent-color: var(--zpdf-accent);
        }
        .zpdf-checkbox-label span {
          color: var(--zpdf-fg) !important;
        }

        .zpdf-status-msg {
          font-size: 11px;
          font-weight: 500;
          line-height: 1.25;
        }
        .zpdf-status-msg[hidden] {
          display: none !important;
        }
        .zpdf-status-ok {
          color: var(--zpdf-success);
        }
        .zpdf-status-warn {
          color: var(--zpdf-warning);
        }
        .zpdf-status-err {
          color: var(--zpdf-danger);
        }

        .zpdf-btn-row {
          display: flex;
          gap: 6px;
          justify-content: flex-end;
          width: 100%;
          min-width: 0;
          box-sizing: border-box;
          margin-top: 2px;
        }
        .zpdf-selection-box .zpdf-btn-row .zpdf-btn {
          flex: 1 1 0;
          min-width: 0;
        }
        .zpdf-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          text-align: center;
          border: none;
          border-radius: 5px;
          padding: 5px 10px;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 11.5px;
          font-weight: 600;
          line-height: 1.2;
          cursor: pointer;
          user-select: none;
          transition: background-color 0.15s ease, opacity 0.15s ease;
        }
        .zpdf-btn-primary {
          background: var(--zpdf-accent);
          color: #ffffff !important;
        }
        .zpdf-btn-primary:hover {
          background: var(--zpdf-accent-hover);
        }
        .zpdf-btn-secondary {
          background: var(--zpdf-btn-sec-bg);
          color: var(--zpdf-btn-sec-fg) !important;
        }
        .zpdf-btn-secondary:hover {
          background: var(--zpdf-btn-sec-hover);
        }
        .zpdf-btn-danger {
          background: var(--zpdf-danger);
          color: #ffffff !important;
        }
        .zpdf-btn-danger:hover {
          background: var(--zpdf-danger-hover);
        }

        .toolbar .custom-sections {
          display: inline-flex;
          align-items: center;
        }
        .toolbar .custom-sections .section {
          display: inline-flex;
          align-items: center;
        }

        .toolbar .toolbar-button.zpdf-toolbar-btn,
        .toolbar-button.zpdf-toolbar-btn,
        .zpdf-toolbar-btn {
          box-sizing: border-box !important;
          display: inline-flex !important;
          flex-direction: row !important;
          flex-wrap: nowrap !important;
          align-items: center !important;
          justify-content: center !important;
          width: auto !important;
          min-width: 28px !important;
          height: 28px !important;
          min-height: 28px !important;
          max-height: 28px !important;
          gap: 5px !important;
          padding: 0 9px !important;
          margin: 0 !important;
          border-radius: 5px !important;
          border: 1px solid var(--zpdf-border-subtle) !important;
          background: transparent;
          color: var(--fill-primary, var(--zpdf-fg));
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 11.5px;
          font-weight: 600;
          line-height: 1 !important;
          white-space: nowrap !important;
          flex-shrink: 0 !important;
          cursor: pointer;
          user-select: none;
          -moz-window-dragging: no-drag;
        }
        .toolbar .toolbar-button.zpdf-toolbar-btn:hover,
        .toolbar-button.zpdf-toolbar-btn:hover,
        .zpdf-toolbar-btn:hover {
          background: var(--zpdf-accent-soft);
          border-color: var(--zpdf-accent) !important;
        }
        .zpdf-toolbar-icon {
          display: inline-flex;
          align-items: center;
          justify-content: center;
          font-size: 13px;
          line-height: 1;
          flex-shrink: 0;
        }
        .zpdf-toolbar-label {
          display: inline-flex;
          align-items: center;
          line-height: 1;
          white-space: nowrap;
        }

        .zpdf-badge {
          display: inline-flex;
          align-items: center;
          padding: 1px 6px;
          border-radius: 999px;
          font-size: 10px;
          font-weight: 600;
          line-height: 1.3;
          white-space: nowrap;
        }
        .zpdf-badge-global {
          background: var(--zpdf-badge-global-bg);
          color: var(--zpdf-badge-global-fg);
        }
        .zpdf-badge-pdf {
          background: var(--zpdf-badge-pdf-bg);
          color: var(--zpdf-badge-pdf-fg);
        }
        .zpdf-badge-neutral {
          background: var(--zpdf-badge-neutral-bg);
          color: var(--zpdf-badge-neutral-fg);
        }

        .zpdf-hover-tooltip {
          position: fixed;
          z-index: 99999;
          max-width: 340px;
          min-width: 190px;
          background: var(--zpdf-tt-bg);
          color: var(--zpdf-tt-fg);
          border: 1px solid var(--zpdf-tt-border);
          border-radius: 8px;
          padding: 9px 11px;
          box-shadow: var(--zpdf-tt-shadow);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 12.5px;
          line-height: 1.4;
          pointer-events: auto;
          transition: opacity 0.12s ease;
        }
        .zpdf-hover-tooltip[hidden] {
          display: none !important;
        }
        .zpdf-tooltip-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          margin-bottom: 4px;
          border-bottom: 1px solid var(--zpdf-border-subtle);
          padding-bottom: 4px;
        }
        .zpdf-tooltip-term {
          font-weight: 700;
          color: var(--zpdf-tt-term);
          font-size: 13px;
          word-break: break-word;
        }
        .zpdf-tooltip-scope {
          font-size: 10px;
          padding: 1px 6px;
          border-radius: 99px;
          background: var(--zpdf-badge-global-bg);
          color: var(--zpdf-badge-global-fg);
          white-space: nowrap;
        }
        .zpdf-tooltip-body {
          white-space: pre-wrap;
          word-break: break-word;
          color: var(--zpdf-tt-fg);
          margin-bottom: 6px;
        }
        .zpdf-tooltip-actions {
          display: flex;
          justify-content: flex-end;
          gap: 6px;
          border-top: 1px solid var(--zpdf-border-subtle);
          padding-top: 5px;
        }
        .zpdf-tooltip-action-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          background: var(--zpdf-tt-btn-bg);
          color: var(--zpdf-tt-btn-fg);
          border: 1px solid var(--zpdf-border-subtle);
          border-radius: 4px;
          padding: 2px 7px;
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 10.5px;
          font-weight: 500;
          cursor: pointer;
        }
        .zpdf-tooltip-action-btn:hover {
          background: var(--zpdf-tt-btn-hover);
        }
        .zpdf-tooltip-action-danger {
          color: var(--zpdf-tt-danger-fg) !important;
        }

        .zpdf-modal-backdrop {
          position: fixed;
          inset: 0;
          z-index: 99998;
          background: rgba(15, 23, 42, 0.52);
          display: flex;
          align-items: center;
          justify-content: center;
          font-family: system-ui, -apple-system, sans-serif;
        }
        .zpdf-modal-backdrop[hidden] {
          display: none !important;
        }
        .zpdf-modal,
        .zpdf-modal.label-popup.preview-popup {
          position: relative !important;
          left: auto !important;
          top: auto !important;
          background: var(--zpdf-bg) !important;
          color: var(--zpdf-fg) !important;
          border: 1px solid var(--zpdf-border) !important;
          border-radius: 10px !important;
          width: 560px !important;
          max-width: 92vw !important;
          max-height: 84vh !important;
          display: flex !important;
          flex-direction: column !important;
          box-shadow: 0 20px 45px rgba(0, 0, 0, 0.42) !important;
          overflow: hidden !important;
          color-scheme: var(--zpdf-color-scheme);
          -moz-user-select: text !important;
          user-select: text !important;
        }
        .zpdf-modal.label-popup.preview-popup::before,
        .zpdf-modal.label-popup.preview-popup::after {
          display: none !important;
          content: none !important;
        }
        .zpdf-modal-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 16px;
          border-bottom: 1px solid var(--zpdf-border-subtle);
          font-weight: 700;
          font-size: 14px;
          color: var(--zpdf-fg);
        }
        .zpdf-modal-body {
          padding: 12px 16px;
          overflow-y: auto;
          display: flex;
          flex-direction: column;
          gap: 10px;
        }
        .zpdf-settings-bar {
          display: flex;
          flex-direction: column;
          gap: 8px;
          padding: 9px 11px;
          border-radius: 7px;
          background: var(--zpdf-surface);
          border: 1px solid var(--zpdf-border-subtle);
        }
        .zpdf-theme-row {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
          font-size: 11.5px;
          font-weight: 600;
          color: var(--zpdf-fg);
        }
        .zpdf-theme-segmented {
          display: inline-flex;
          border-radius: 6px;
          border: 1px solid var(--zpdf-border);
          background: var(--zpdf-input-bg);
          padding: 2px;
          gap: 2px;
        }
        .zpdf-seg-btn {
          box-sizing: border-box;
          display: inline-flex;
          align-items: center;
          justify-content: center;
          gap: 4px;
          padding: 3px 9px;
          border-radius: 4px;
          border: none;
          background: transparent;
          color: var(--zpdf-fg-muted);
          font-family: system-ui, -apple-system, sans-serif;
          font-size: 11px;
          font-weight: 600;
          cursor: pointer;
          user-select: none;
        }
        .zpdf-seg-btn:hover {
          color: var(--zpdf-fg);
        }
        .zpdf-seg-btn.is-active {
          background: var(--zpdf-accent);
          color: #ffffff !important;
        }
        .zpdf-def-list-item {
          display: flex;
          flex-direction: column;
          gap: 6px;
          padding: 9px 11px;
          border-radius: 7px;
          border: 1px solid var(--zpdf-border-subtle);
          background: var(--zpdf-surface);
          color: var(--zpdf-fg);
        }
        .zpdf-def-list-top {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: 8px;
          flex-wrap: wrap;
        }
        .zpdf-empty-hint {
          font-size: 12px;
          color: var(--zpdf-fg-muted);
          padding: 8px 2px;
        }
      `;
      if (isNewStyle) {
        doc.head.appendChild(style);
      }
    }

    let tooltip = doc.getElementById("zpdf-hover-tooltip");
    if (!tooltip) {
      tooltip = doc.createElement("div");
      tooltip.id = "zpdf-hover-tooltip";
      tooltip.className = "zpdf-hover-tooltip";
      tooltip.hidden = true;

      tooltip.addEventListener("mouseenter", () => {
        if (tooltip._hideTimer) {
          rWin.clearTimeout(tooltip._hideTimer);
          tooltip._hideTimer = null;
        }
      });
      tooltip.addEventListener("mouseleave", () => {
        this.scheduleHideTooltip(reader, 160);
      });

      doc.body.appendChild(tooltip);
    }

    let modalBackdrop = doc.getElementById("zpdf-modal-backdrop");
    if (!modalBackdrop) {
      modalBackdrop = doc.createElement("div");
      modalBackdrop.id = "zpdf-modal-backdrop";
      modalBackdrop.className = "zpdf-modal-backdrop";
      modalBackdrop.hidden = true;
      modalBackdrop.addEventListener("click", (e) => {
        if (e.target === modalBackdrop) {
          modalBackdrop.hidden = true;
        }
      });
      doc.body.appendChild(modalBackdrop);
    }

    return { doc, tooltip, modalBackdrop };
  }

  /**
   * 1. Handler für Zoteros Text-Auswahl-Popup (`renderTextSelectionPopup`).
   */
  onRenderTextSelectionPopup(event) {
    try {
      const { reader, doc, params, append } = event;
      const rawSelected = params?.annotation?.text || "";
      const selectedTerm = normalizeWhitespace(rawSelected);
      if (!selectedTerm) return;

      this.ensureReaderUI(reader);
      const docKey = this.getDocKey(reader);
      const docTitle = this.getDocTitle(reader);
      let loadedDef = this.findDefinitionForTerm(selectedTerm, docKey);
      const defaults = inferDefaultMatchOptions(selectedTerm);

      const container = doc.createElement("div");
      // Zoteros KeyboardManager & FocusManager prüfen im Capture-Phase-Keydown-Listener
      // auf `event.target.closest('input, .label-popup')` sowie `[contenteditable], .preview-popup`.
      // Ohne diese Klassen ruft Zotero bei Backspace/Delete `deleteAnnotations([])` auf,
      // was die aktuelle Auswahl verwirft und das Auswahl-Popup sofort schließt.
      container.className = "zpdf-selection-box label-popup preview-popup";

      // Kopfzeile mit Titel + Dark/Light/Auto-Umschalter
      const header = doc.createElement("div");
      header.className = "zpdf-selection-header";
      const titleSpan = doc.createElement("span");
      titleSpan.className = "zpdf-selection-title";
      titleSpan.textContent = loadedDef ? "📖 Bearbeiten" : "📖 Definieren";
      header.appendChild(titleSpan);

      const themeBtn = doc.createElement("button");
      themeBtn.type = "button";
      themeBtn.className = "zpdf-theme-btn";
      const syncThemeBtn = () => {
        const meta = this.getThemeButtonMeta(reader);
        themeBtn.textContent = meta.label;
        themeBtn.title = meta.title;
      };
      syncThemeBtn();
      themeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        e.preventDefault();
        const nextMode = this.getNextThemeMode(reader);
        this.setThemeMode(nextMode);
        syncThemeBtn();
      });
      header.appendChild(themeBtn);
      container.appendChild(header);

      // Warnhinweis-Box falls der Ausdruck bereits (global, lokal oder in anderem PDF) definiert ist
      const dupWarning = doc.createElement("div");
      dupWarning.className = "zpdf-dup-warning";
      dupWarning.hidden = true;
      container.appendChild(dupWarning);

      // Eingabefeld für den Ausdruck/Buchstaben/Wortgruppe
      const termInput = doc.createElement("input");
      termInput.type = "text";
      termInput.className = "zpdf-input";
      termInput.setAttribute("contenteditable", "true");
      termInput.value = loadedDef ? loadedDef.term : selectedTerm;
      termInput.placeholder = "Ausdruck / Buchstabe…";
      termInput.title = "Ausdruck, der im PDF erkannt werden soll";
      container.appendChild(termInput);

      // Eingabefeld für die Definition
      const defInput = doc.createElement("textarea");
      defInput.className = "zpdf-textarea";
      defInput.setAttribute("contenteditable", "true");
      defInput.value = loadedDef ? loadedDef.definition : "";
      defInput.placeholder = "Definition eingeben… (Strg+Enter)";
      container.appendChild(defInput);

      // Optionen sauber in 2 Zeilen innerhalb der Popup-Breite anordnen
      const optsCol = doc.createElement("div");
      optsCol.className = "zpdf-options-col";

      const makeCheckbox = (labelText, checked, tooltipText) => {
        const lbl = doc.createElement("label");
        lbl.className = "zpdf-checkbox-label";
        lbl.title = tooltipText;
        const cb = doc.createElement("input");
        cb.type = "checkbox";
        cb.checked = checked;
        const span = doc.createElement("span");
        span.textContent = labelText;
        lbl.appendChild(cb);
        lbl.appendChild(span);
        return { lbl, cb };
      };

      const globalOpt = makeCheckbox(
        "🌍 Global (alle PDFs)",
        loadedDef ? loadedDef.scope === "global" : false,
        "Wenn aktiviert, gilt diese Definition in allen PDFs in Zotero."
      );
      const caseOpt = makeCheckbox(
        "Groß/Klein",
        loadedDef ? Boolean(loadedDef.caseSensitive) : defaults.caseSensitive,
        "Groß- und Kleinschreibung exakt beachten (empfohlen für einzelne Buchstaben/Variablen wie E vs. e)."
      );
      const wordOpt = makeCheckbox(
        "Wortgrenze",
        loadedDef ? Boolean(loadedDef.wholeWord) : defaults.wholeWord,
        "Nur freistehende Wörter/Ausdrücke markieren (deaktivieren, wenn der Ausdruck auch innerhalb von Wörtern/Formeln gefunden werden soll)."
      );

      const optsRow1 = doc.createElement("div");
      optsRow1.className = "zpdf-options-row";
      optsRow1.appendChild(globalOpt.lbl);

      const optsRow2 = doc.createElement("div");
      optsRow2.className = "zpdf-options-row zpdf-options-row-split";
      optsRow2.appendChild(caseOpt.lbl);
      optsRow2.appendChild(wordOpt.lbl);

      optsCol.appendChild(optsRow1);
      optsCol.appendChild(optsRow2);
      container.appendChild(optsCol);

      // Status-Zeile (nur bei Meldung sichtbar, damit Buttons nie gequetscht werden)
      const statusMsg = doc.createElement("div");
      statusMsg.className = "zpdf-status-msg";
      statusMsg.hidden = true;
      container.appendChild(statusMsg);

      const setStatus = (text, kind) => {
        statusMsg.textContent = text;
        statusMsg.className = `zpdf-status-msg zpdf-status-${kind}`;
        statusMsg.hidden = !text;
      };

      // Aktionsbuttons (100% bündig innerhalb des Popups)
      const btnRow = doc.createElement("div");
      btnRow.className = "zpdf-btn-row";

      const delBtn = doc.createElement("button");
      delBtn.type = "button";
      delBtn.className = "zpdf-btn zpdf-btn-danger";
      delBtn.textContent = "Löschen";
      delBtn.hidden = !loadedDef;
      btnRow.appendChild(delBtn);

      const saveBtn = doc.createElement("button");
      saveBtn.type = "button";
      saveBtn.className = "zpdf-btn zpdf-btn-primary";
      saveBtn.textContent = loadedDef ? "Aktualisieren" : "Definieren";

      const loadExistingIntoForm = (defObj) => {
        if (!defObj) return;
        loadedDef = defObj;
        termInput.value = defObj.term;
        defInput.value = defObj.definition;
        globalOpt.cb.checked = defObj.scope === "global";
        caseOpt.cb.checked = Boolean(defObj.caseSensitive);
        wordOpt.cb.checked = Boolean(defObj.wholeWord);
        syncConflictUI();
      };

      const syncConflictUI = () => {
        const currentTerm = normalizeWhitespace(termInput.value);
        const { localMatch, globalMatch, otherPdfMatches } = this.findConflictsForTerm(
          currentTerm,
          docKey
        );
        const wantGlobal = globalOpt.cb.checked;
        const activeSameScope = wantGlobal ? globalMatch : localMatch;
        const deletableTarget = activeSameScope || localMatch || globalMatch;

        dupWarning.replaceChildren();

        if (globalMatch || localMatch) {
          dupWarning.hidden = false;
          const wTitle = doc.createElement("div");
          wTitle.className = "zpdf-dup-warning-title";

          const wPreview = doc.createElement("div");
          wPreview.className = "zpdf-dup-warning-preview";

          let targetForLoad = null;

          if (globalMatch && localMatch) {
            wTitle.textContent = "⚠️ Bereits lokal & global definiert";
            const shown = wantGlobal ? globalMatch : localMatch;
            wPreview.textContent = `${
              wantGlobal ? "Global" : "Dieses PDF"
            }: „${shown.definition}“`;
            if (loadedDef?.id !== shown.id) targetForLoad = shown;
          } else if (globalMatch) {
            wTitle.textContent = "⚠️ Bereits global definiert";
            if (wantGlobal) {
              wPreview.textContent = `„${globalMatch.definition}“`;
              if (loadedDef?.id !== globalMatch.id) targetForLoad = globalMatch;
            } else {
              wPreview.textContent = `„${globalMatch.definition}“\n(Speichern legt eine eigene Definition nur für dieses PDF an.)`;
              if (!defInput.value.trim()) targetForLoad = globalMatch;
            }
          } else if (localMatch) {
            wTitle.textContent = "⚠️ Bereits in diesem PDF definiert";
            wPreview.textContent = `„${localMatch.definition}“`;
            if (loadedDef?.id !== localMatch.id) targetForLoad = localMatch;
          }

          dupWarning.appendChild(wTitle);
          dupWarning.appendChild(wPreview);

          if (targetForLoad) {
            const loadBtn = doc.createElement("button");
            loadBtn.type = "button";
            loadBtn.className = "zpdf-dup-inline-btn";
            loadBtn.textContent = "Bestehende laden";
            loadBtn.addEventListener("click", (e) => {
              e.stopPropagation();
              loadExistingIntoForm(targetForLoad);
            });
            dupWarning.appendChild(loadBtn);
          }
        } else if (otherPdfMatches.length > 0) {
          const other = otherPdfMatches[0];
          dupWarning.hidden = false;

          const wTitle = doc.createElement("div");
          wTitle.className = "zpdf-dup-warning-title";
          wTitle.textContent = "ℹ️ Bereits in anderem PDF definiert";

          const wPreview = doc.createElement("div");
          wPreview.className = "zpdf-dup-warning-preview";
          wPreview.textContent = `${other.docTitle || "PDF"}: „${other.definition}“`;

          const copyBtn = doc.createElement("button");
          copyBtn.type = "button";
          copyBtn.className = "zpdf-dup-inline-btn";
          copyBtn.textContent = "Übernehmen & global";
          copyBtn.addEventListener("click", (e) => {
            e.stopPropagation();
            defInput.value = other.definition;
            globalOpt.cb.checked = true;
            caseOpt.cb.checked = Boolean(other.caseSensitive);
            wordOpt.cb.checked = Boolean(other.wholeWord);
            syncConflictUI();
          });

          dupWarning.appendChild(wTitle);
          dupWarning.appendChild(wPreview);
          dupWarning.appendChild(copyBtn);
        } else {
          dupWarning.hidden = true;
        }

        titleSpan.textContent = activeSameScope ? "📖 Bearbeiten" : "📖 Definieren";
        delBtn.hidden = !deletableTarget;
        delBtn._targetDef = deletableTarget;

        if (activeSameScope) {
          saveBtn.textContent = "Aktualisieren";
        } else if (globalMatch && !wantGlobal) {
          saveBtn.textContent = "Für PDF definieren";
        } else {
          saveBtn.textContent = "Definieren";
        }
      };

      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const target = delBtn._targetDef || loadedDef;
        if (!target) return;
        this.deleteDefinition(target.id);
        if (loadedDef?.id === target.id) {
          loadedDef = null;
        }
        defInput.value = "";
        syncConflictUI();
        setStatus("Gelöscht ✓", "err");
      });

      termInput.addEventListener("input", () => {
        if (!loadedDef) {
          const auto = inferDefaultMatchOptions(termInput.value);
          caseOpt.cb.checked = auto.caseSensitive;
          wordOpt.cb.checked = auto.wholeWord;
        }
        syncConflictUI();
      });

      globalOpt.cb.addEventListener("change", () => {
        syncConflictUI();
      });

      const performSave = () => {
        const tVal = normalizeWhitespace(termInput.value);
        const dVal = defInput.value.trim();
        if (!tVal || !dVal) {
          setStatus("Bitte Ausdruck & Definition eingeben", "warn");
          return;
        }
        const wantGlobal = globalOpt.cb.checked;
        const { localMatch, globalMatch } = this.findConflictsForTerm(tVal, docKey);
        let targetId;
        if (wantGlobal) {
          targetId =
            globalMatch?.id ||
            (loadedDef?.scope === "pdf" &&
            normalizeWhitespace(loadedDef.term).toLowerCase() === tVal.toLowerCase()
              ? loadedDef.id
              : undefined);
        } else {
          targetId = localMatch?.id;
        }

        const saved = this.upsertDefinition({
          id: targetId,
          term: tVal,
          definition: dVal,
          scope: wantGlobal ? "global" : "pdf",
          docKey,
          docTitle,
          caseSensitive: caseOpt.cb.checked,
          wholeWord: wordOpt.cb.checked,
        });
        loadedDef = saved;
        syncConflictUI();
        setStatus("Gespeichert ✓", "ok");
      };

      syncConflictUI();

      saveBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        performSave();
      });

      defInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if ((e.ctrlKey || e.metaKey) && e.key === "Enter") {
          e.preventDefault();
          performSave();
        }
      });
      defInput.addEventListener("keyup", (e) => e.stopPropagation());
      defInput.addEventListener("keypress", (e) => e.stopPropagation());
      termInput.addEventListener("keydown", (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          e.preventDefault();
          performSave();
        }
      });
      termInput.addEventListener("keyup", (e) => e.stopPropagation());
      termInput.addEventListener("keypress", (e) => e.stopPropagation());

      btnRow.appendChild(saveBtn);
      container.appendChild(btnRow);

      append(container);
    } catch (err) {
      this.log(`Fehler in onRenderTextSelectionPopup: ${err}`);
    }
  }

  setToolbarButtonContent(btn, count) {
    const doc = btn?.ownerDocument;
    if (!doc || typeof doc.createElement !== "function" || typeof btn.replaceChildren !== "function") {
      btn.textContent = `📖 Glossar (${count})`;
      return;
    }
    btn.replaceChildren();
    const iconSpan = doc.createElement("span");
    iconSpan.className = "zpdf-toolbar-icon";
    iconSpan.setAttribute("aria-hidden", "true");
    iconSpan.textContent = "📖";

    const labelSpan = doc.createElement("span");
    labelSpan.className = "zpdf-toolbar-label";
    labelSpan.textContent = ` Glossar (${count})`;

    btn.appendChild(iconSpan);
    btn.appendChild(labelSpan);
  }

  createToolbarButton(reader, doc) {
    const docKey = this.getDocKey(reader);
    const activeCount = this.getActiveDefinitionsForDoc(docKey).length;

    const btn = doc.createElement("button");
    btn.type = "button";
    btn.className = "toolbar-button zpdf-toolbar-btn";
    btn.title = "Definierte Ausdrücke & Glossar für dieses PDF und global verwalten";
    btn.dataset.zpdfToolbarCount = "true";
    btn._zpdfOwner = this;
    this.setToolbarButtonContent(btn, activeCount);

    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.openGlossaryModal(reader);
    });

    return btn;
  }

  /**
   * 2. Handler für die PDF-Reader-Toolbar (`renderToolbar`):
   *    Fügt einen Button "📖 Glossar" hinzu, über den alle lokalen & globalen Definitionen
   *    eingesehen, durchsucht, angelegt oder bearbeitet werden können.
   */
  onRenderToolbar(event) {
    try {
      const { reader, doc, append } = event;
      this.ensureReaderUI(reader);
      const btn = this.createToolbarButton(reader, doc);
      append(btn);
    } catch (err) {
      this.log(`Fehler in onRenderToolbar: ${err}`);
    }
  }

  /**
   * 3. Kontextmenü-Eintrag (`createViewContextMenu`) im PDF-Reader.
   */
  onCreateViewContextMenu(event) {
    try {
      const { reader, append } = event;
      append({
        label: "📖 PDF-Glossar & Definitionen öffnen…",
        onCommand: () => {
          this.openGlossaryModal(reader);
        },
      });
    } catch (err) {
      this.log(`Fehler in onCreateViewContextMenu: ${err}`);
    }
  }

  /**
   * Öffnet das Glossar-Verwaltungsfenster innerhalb des aktuellen PDF-Readers.
   */
  openGlossaryModal(reader, initialEditDef = null, prefillTerm = "") {
    const ui = this.ensureReaderUI(reader);
    if (!ui) return;
    const { doc, modalBackdrop } = ui;
    const docKey = this.getDocKey(reader);
    const docTitle = this.getDocTitle(reader);

    const renderModalContent = (editDef = initialEditDef, filterText = "") => {
      modalBackdrop.replaceChildren();
      const modal = doc.createElement("div");
      modal.className = "zpdf-modal label-popup preview-popup";

      // Header
      const header = doc.createElement("div");
      header.className = "zpdf-modal-header";
      const hTitle = doc.createElement("span");
      hTitle.textContent = "📖 PDF-Definitionen & Glossar";
      const closeBtn = doc.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "zpdf-btn zpdf-btn-secondary";
      closeBtn.textContent = "✕ Schließen";
      closeBtn.addEventListener("click", () => {
        modalBackdrop.hidden = true;
      });
      header.appendChild(hTitle);
      header.appendChild(closeBtn);
      modal.appendChild(header);

      const body = doc.createElement("div");
      body.className = "zpdf-modal-body";

      // Einstellungen: Farbschema (Auto / Darkmode / Lightmode) + dezente Unterstreichung
      const settingsBar = doc.createElement("div");
      settingsBar.className = "zpdf-settings-bar";

      const themeRow = doc.createElement("div");
      themeRow.className = "zpdf-theme-row";
      const themeLabel = doc.createElement("span");
      themeLabel.textContent = "🎨 Erscheinungsbild:";
      themeRow.appendChild(themeLabel);

      const segGroup = doc.createElement("div");
      segGroup.className = "zpdf-theme-segmented";
      const themeOptions = [
        { mode: "auto", text: "🌓 Automatisch" },
        { mode: "dark", text: "🌙 Darkmode" },
        { mode: "light", text: "☀️ Lightmode" },
      ];
      for (const opt of themeOptions) {
        const sBtn = doc.createElement("button");
        sBtn.type = "button";
        sBtn.className = `zpdf-seg-btn${
          (this.themeMode || "auto") === opt.mode ? " is-active" : ""
        }`;
        sBtn.textContent = opt.text;
        sBtn.addEventListener("click", () => {
          this.setThemeMode(opt.mode);
          for (const child of segGroup.children) {
            child.classList.remove("is-active");
          }
          sBtn.classList.add("is-active");
        });
        segGroup.appendChild(sBtn);
      }
      themeRow.appendChild(segGroup);
      settingsBar.appendChild(themeRow);

      const hintLbl = doc.createElement("label");
      hintLbl.className = "zpdf-checkbox-label";
      const hintCb = doc.createElement("input");
      hintCb.type = "checkbox";
      hintCb.checked = Boolean(this.subtleHint);
      hintCb.addEventListener("change", () => {
        this.subtleHint = hintCb.checked;
        this._defsStamp = (this._defsStamp || 0) + 1;
        this.saveStore();
        this.refreshAllReaders();
      });
      const hintSpan = doc.createElement("span");
      hintSpan.textContent =
        "Dezente gepunktete Linie unter definierten Begriffen im PDF anzeigen";
      hintLbl.appendChild(hintCb);
      hintLbl.appendChild(hintSpan);
      settingsBar.appendChild(hintLbl);
      body.appendChild(settingsBar);

      // Formular zum Hinzufügen / Bearbeiten einer Definition
      const formBox = doc.createElement("div");
      formBox.className = "zpdf-def-list-item";

      const formTitle = doc.createElement("div");
      formTitle.style.fontWeight = "600";
      formTitle.style.fontSize = "12px";
      formTitle.textContent = editDef
        ? `Definition bearbeiten: „${editDef.term}“`
        : "Neue Definition anlegen";
      formBox.appendChild(formTitle);

      const termInput = doc.createElement("input");
      termInput.type = "text";
      termInput.className = "zpdf-input";
      termInput.setAttribute("contenteditable", "true");
      termInput.placeholder = "Ausdruck, Buchstabe, Symbol oder Wortgruppe…";
      termInput.value = editDef ? editDef.term : prefillTerm;
      termInput.addEventListener("keydown", (e) => e.stopPropagation());
      termInput.addEventListener("keyup", (e) => e.stopPropagation());
      formBox.appendChild(termInput);

      const modalDupWarning = doc.createElement("div");
      modalDupWarning.className = "zpdf-dup-warning";
      modalDupWarning.hidden = true;
      formBox.appendChild(modalDupWarning);

      const defInput = doc.createElement("textarea");
      defInput.className = "zpdf-textarea";
      defInput.setAttribute("contenteditable", "true");
      defInput.placeholder = "Definition / Erklärung…";
      defInput.value = editDef ? editDef.definition : "";
      defInput.addEventListener("keydown", (e) => e.stopPropagation());
      defInput.addEventListener("keyup", (e) => e.stopPropagation());
      formBox.appendChild(defInput);

      const defaults = inferDefaultMatchOptions(termInput.value || "wort");
      const formOpts = doc.createElement("div");
      formOpts.className = "zpdf-options-row";

      const makeCb = (text, checked) => {
        const l = doc.createElement("label");
        l.className = "zpdf-checkbox-label";
        const c = doc.createElement("input");
        c.type = "checkbox";
        c.checked = checked;
        const s = doc.createElement("span");
        s.textContent = text;
        l.appendChild(c);
        l.appendChild(s);
        return { l, c };
      };

      const cbGlobal = makeCb(
        "🌍 Global für alle PDFs in Zotero",
        editDef ? editDef.scope === "global" : false
      );
      const cbCase = makeCb(
        "Aa Groß-/Kleinschreibung beachten",
        editDef ? Boolean(editDef.caseSensitive) : defaults.caseSensitive
      );
      const cbWord = makeCb(
        "Wortgrenze (ganze Wörter)",
        editDef ? Boolean(editDef.wholeWord) : defaults.wholeWord
      );

      const syncModalConflict = () => {
        const { localMatch, globalMatch, otherPdfMatches } = this.findConflictsForTerm(
          termInput.value,
          docKey,
          editDef?.id
        );
        modalDupWarning.replaceChildren();
        const conflict = globalMatch || localMatch || otherPdfMatches[0] || null;
        if (!conflict) {
          modalDupWarning.hidden = true;
          return;
        }
        modalDupWarning.hidden = false;

        const wTitle = doc.createElement("div");
        wTitle.className = "zpdf-dup-warning-title";
        if (globalMatch) {
          wTitle.textContent = `⚠️ „${globalMatch.term}“ ist bereits global definiert`;
        } else if (localMatch) {
          wTitle.textContent = `⚠️ „${localMatch.term}“ ist bereits in diesem PDF definiert`;
        } else {
          wTitle.textContent = `ℹ️ „${conflict.term}“ ist bereits in „${
            conflict.docTitle || "anderem PDF"
          }“ definiert`;
        }

        const wPreview = doc.createElement("div");
        wPreview.className = "zpdf-dup-warning-preview";
        wPreview.textContent = `„${conflict.definition}“`;

        const actionBtn = doc.createElement("button");
        actionBtn.type = "button";
        actionBtn.className = "zpdf-dup-inline-btn";
        if (globalMatch || localMatch) {
          actionBtn.textContent = "Bestehende Definition bearbeiten";
          actionBtn.addEventListener("click", () => {
            renderModalContent(globalMatch || localMatch, searchInput.value);
          });
        } else {
          actionBtn.textContent = "Text übernehmen";
          actionBtn.addEventListener("click", () => {
            defInput.value = conflict.definition;
          });
        }

        modalDupWarning.appendChild(wTitle);
        modalDupWarning.appendChild(wPreview);
        modalDupWarning.appendChild(actionBtn);
      };

      termInput.addEventListener("input", () => {
        if (!editDef) {
          const auto = inferDefaultMatchOptions(termInput.value);
          cbCase.c.checked = auto.caseSensitive;
          cbWord.c.checked = auto.wholeWord;
        }
        syncModalConflict();
      });
      cbGlobal.c.addEventListener("change", syncModalConflict);

      formOpts.appendChild(cbGlobal.l);
      formOpts.appendChild(cbCase.l);
      formOpts.appendChild(cbWord.l);
      formBox.appendChild(formOpts);

      const formBtns = doc.createElement("div");
      formBtns.className = "zpdf-btn-row";
      if (editDef) {
        const cancelEditBtn = doc.createElement("button");
        cancelEditBtn.type = "button";
        cancelEditBtn.className = "zpdf-btn zpdf-btn-secondary";
        cancelEditBtn.textContent = "Abbrechen";
        cancelEditBtn.addEventListener("click", () => renderModalContent(null, filterText));
        formBtns.appendChild(cancelEditBtn);
      }
      const saveFormBtn = doc.createElement("button");
      saveFormBtn.type = "button";
      saveFormBtn.className = "zpdf-btn zpdf-btn-primary";
      saveFormBtn.textContent = editDef ? "Änderungen speichern" : "Hinzufügen";
      saveFormBtn.addEventListener("click", () => {
        const t = normalizeWhitespace(termInput.value);
        const d = defInput.value.trim();
        if (!t || !d) return;
        this.upsertDefinition({
          id: editDef?.id,
          term: t,
          definition: d,
          scope: cbGlobal.c.checked ? "global" : "pdf",
          docKey,
          docTitle,
          caseSensitive: cbCase.c.checked,
          wholeWord: cbWord.c.checked,
        });
        prefillTerm = "";
        renderModalContent(null, filterText);
      });
      formBtns.appendChild(saveFormBtn);
      formBox.appendChild(formBtns);
      body.appendChild(formBox);

      // Suchfeld für bestehende Definitionen
      const searchInput = doc.createElement("input");
      searchInput.type = "text";
      searchInput.className = "zpdf-input";
      searchInput.setAttribute("contenteditable", "true");
      searchInput.placeholder = "Definitionen durchsuchen…";
      searchInput.value = filterText;
      searchInput.addEventListener("keydown", (e) => e.stopPropagation());
      searchInput.addEventListener("keyup", (e) => e.stopPropagation());
      searchInput.addEventListener("input", () => {
        renderList(searchInput.value);
      });
      body.appendChild(searchInput);

      syncModalConflict();

      const listContainer = doc.createElement("div");
      listContainer.style.display = "flex";
      listContainer.style.flexDirection = "column";
      listContainer.style.gap = "8px";
      body.appendChild(listContainer);

      const renderList = (query) => {
        listContainer.replaceChildren();
        const q = normalizeWhitespace(query).toLowerCase();
        const relevant = this.definitions.filter((d) => {
          const isForThisDocOrGlobal =
            d.scope === "global" || (d.scope === "pdf" && d.docKey === docKey);
          if (!isForThisDocOrGlobal) return false;
          if (!q) return true;
          return (
            d.term.toLowerCase().includes(q) ||
            d.definition.toLowerCase().includes(q)
          );
        });

        if (relevant.length === 0) {
          const empty = doc.createElement("div");
          empty.className = "zpdf-empty-hint";
          empty.textContent =
            "Noch keine Definitionen für dieses PDF oder global vorhanden. Markiere einfach Text im PDF oder lege oben eine Definition an.";
          listContainer.appendChild(empty);
          return;
        }

        for (const item of relevant) {
          const card = doc.createElement("div");
          card.className = "zpdf-def-list-item";

          const top = doc.createElement("div");
          top.className = "zpdf-def-list-top";

          const left = doc.createElement("div");
          left.style.display = "flex";
          left.style.alignItems = "center";
          left.style.gap = "6px";
          left.style.flexWrap = "wrap";

          const termStrong = doc.createElement("strong");
          termStrong.style.fontSize = "13px";
          termStrong.textContent = item.term;
          left.appendChild(termStrong);

          const scopeBadge = doc.createElement("span");
          scopeBadge.className = `zpdf-badge ${
            item.scope === "global" ? "zpdf-badge-global" : "zpdf-badge-pdf"
          }`;
          scopeBadge.textContent =
            item.scope === "global" ? "🌍 Global (alle PDFs)" : "📄 Nur dieses PDF";
          left.appendChild(scopeBadge);

          if (item.caseSensitive) {
            const csBadge = doc.createElement("span");
            csBadge.className = "zpdf-badge zpdf-badge-neutral";
            csBadge.textContent = "Aa";
            left.appendChild(csBadge);
          }

          top.appendChild(left);

          const actions = doc.createElement("div");
          actions.style.display = "flex";
          actions.style.gap = "4px";

          const toggleScopeBtn = doc.createElement("button");
          toggleScopeBtn.type = "button";
          toggleScopeBtn.className = "zpdf-btn zpdf-btn-secondary";
          toggleScopeBtn.style.padding = "2px 7px";
          toggleScopeBtn.style.fontSize = "11px";
          toggleScopeBtn.textContent =
            item.scope === "global" ? "→ Nur dieses PDF" : "→ Global machen";
          toggleScopeBtn.addEventListener("click", () => {
            this.upsertDefinition({
              ...item,
              scope: item.scope === "global" ? "pdf" : "global",
              docKey,
              docTitle,
            });
            renderList(searchInput.value);
          });
          actions.appendChild(toggleScopeBtn);

          const editBtn = doc.createElement("button");
          editBtn.type = "button";
          editBtn.className = "zpdf-btn zpdf-btn-secondary";
          editBtn.style.padding = "2px 7px";
          editBtn.style.fontSize = "11px";
          editBtn.textContent = "Bearbeiten";
          editBtn.addEventListener("click", () => {
            renderModalContent(item, searchInput.value);
          });
          actions.appendChild(editBtn);

          const delBtn = doc.createElement("button");
          delBtn.type = "button";
          delBtn.className = "zpdf-btn zpdf-btn-danger";
          delBtn.style.padding = "2px 7px";
          delBtn.style.fontSize = "11px";
          delBtn.textContent = "Löschen";
          delBtn.addEventListener("click", () => {
            this.deleteDefinition(item.id);
            renderList(searchInput.value);
          });
          actions.appendChild(delBtn);

          top.appendChild(actions);
          card.appendChild(top);

          const defText = doc.createElement("div");
          defText.style.fontSize = "12px";
          defText.style.whiteSpace = "pre-wrap";
          defText.textContent = item.definition;
          card.appendChild(defText);

          listContainer.appendChild(card);
        }
      };

      renderList(filterText);
      modal.appendChild(body);
      modalBackdrop.appendChild(modal);
      modalBackdrop.hidden = false;
    };

    renderModalContent(initialEditDef, "");
  }

  /**
   * Durchsucht alle offenen `Zotero.Reader`-Instanzen und hängt unsere PDF-Seiten- und
   * Hover-Überwachung an jede `PDFView` (`_primaryView` / `_secondaryView`) an.
   */
  scanOpenReaders() {
    const readers = Zotero.Reader?._readers || [];
    for (const reader of readers) {
      if (!reader || reader.type !== "pdf" || !reader._iframeWindow) continue;
      this.ensureReaderUI(reader);
      this.ensureToolbarButtonInReader(reader);
      this.attachToReaderViews(reader);
    }
  }

  ensureToolbarButtonInReader(reader) {
    try {
      const doc = reader?._iframeWindow?.document;
      if (!doc || typeof doc.querySelectorAll !== "function") return;
      const existingBtns = doc.querySelectorAll(".zpdf-toolbar-btn");
      if (existingBtns.length > 0) {
        for (const oldBtn of existingBtns) {
          if (oldBtn._zpdfOwner !== this && typeof oldBtn.replaceWith === "function") {
            const freshBtn = this.createToolbarButton(reader, doc);
            oldBtn.replaceWith(freshBtn);
          }
        }
        return;
      }
      const customSections = doc.querySelector?.(".toolbar .custom-sections");
      if (customSections) {
        const section = doc.createElement("div");
        section.className = "section zpdf-toolbar-section";
        section.appendChild(this.createToolbarButton(reader, doc));
        customSections.appendChild(section);
      }
    } catch (_) {}
  }

  attachToReaderViews(reader) {
    try {
      const internalReader = waive(reader._internalReader);
      if (!internalReader) return;

      const views = [internalReader._primaryView, internalReader._secondaryView].filter(
        Boolean
      );
      for (const pdfView of views) {
        const waivedView = waive(pdfView);
        const rawPdfWin = waivedView?._iframeWindow;
        const pdfWin = unwaive(rawPdfWin);
        if (!pdfWin || !pdfWin.document) continue;

        if (!this._hookedPdfViews.has(waivedView)) {
          this._hookedPdfViews.add(waivedView);
          this.setupPdfViewHooks(reader, waivedView, pdfWin, rawPdfWin);
        }
      }
    } catch (err) {
      this.log(`attachToReaderViews Fehler: ${err}`);
    }
  }

  /**
   * Richtet in `pdf/web/viewer.html` (`pdfWin`) das CSS für unsichtbare/gepunktete Markierungen,
   * Event-Listener für `pagerendered`/`textlayerrendered` sowie den passiven
   * `pointermove`-Hover-Detektor ein.
   */
  setupPdfViewHooks(reader, pdfView, pdfWin, rawPdfWin) {
    const waivedView = waive(pdfView);
    const cleanPdfWin = unwaive(pdfWin || waivedView?._iframeWindow);
    const pdfDoc = cleanPdfWin?.document;
    if (!pdfDoc) return;

    if (pdfDoc.documentElement) {
      pdfDoc.documentElement.setAttribute(
        "data-zpdf-theme",
        this.resolveEffectiveTheme(reader)
      );
    }

    let style = pdfDoc.getElementById("zpdf-inner-viewer-styles");
    const styleVer = this.version || "1.0.6";
    if (!style || style.dataset?.zpdfVersion !== styleVer) {
      if (!style) {
        style = pdfDoc.createElement("style");
        style.id = "zpdf-inner-viewer-styles";
        pdfDoc.head.appendChild(style);
      }
      if (style.dataset) {
        style.dataset.zpdfVersion = styleVer;
      }
      style.textContent = `
        .zpdf-def-layer {
          position: absolute;
          inset: 0;
          pointer-events: none !important;
          z-index: 4;
          overflow: hidden;
        }
        .zpdf-def-mark {
          position: absolute;
          pointer-events: none !important;
          border-radius: 2px;
          box-sizing: border-box;
          background: transparent;
          border-bottom: 2px dotted transparent;
          transition: background-color 0.1s ease, border-color 0.1s ease;
        }
        .zpdf-def-layer.zpdf-subtle-hint .zpdf-def-mark {
          border-bottom: 2px dotted rgba(79, 70, 229, 0.78) !important;
        }
        :root[data-zpdf-theme="dark"] .zpdf-def-layer.zpdf-subtle-hint .zpdf-def-mark {
          border-bottom: 2px dotted rgba(129, 140, 248, 0.85) !important;
        }
        .zpdf-def-mark.zpdf-def-mark-hovered {
          background-color: rgba(56, 189, 248, 0.22) !important;
          border-bottom: 2px solid #0284c7 !important;
        }
        :root[data-zpdf-theme="dark"] .zpdf-def-mark.zpdf-def-mark-hovered {
          background-color: rgba(56, 189, 248, 0.32) !important;
          border-bottom: 2px solid #38bdf8 !important;
        }
      `;
    }

    const waivedApp = waive(waivedView?._iframeWindow?.PDFViewerApplication || rawPdfWin?.PDFViewerApplication);
    const eventBus = waivedApp?.eventBus;
    if (eventBus && typeof eventBus.on === "function") {
      const safeRegister = (eventName, fn) => {
        try {
          let exported = fn;
          if (
            typeof Components !== "undefined" &&
            typeof Components.utils?.exportFunction === "function"
          ) {
            exported = Components.utils.exportFunction(fn, cleanPdfWin);
          }
          eventBus.on(eventName, exported);
        } catch (_) {
          try {
            eventBus.on(eventName, fn);
          } catch (e) {}
        }
      };

      safeRegister("pagerendered", (evt) => {
        const pageIndex = (evt?.pageNumber || 1) - 1;
        this.indexAndRenderPage(reader, waivedView, pageIndex);
        cleanPdfWin.setTimeout?.(() => {
          this.indexAndRenderPage(reader, waivedView, pageIndex);
        }, 180);
        cleanPdfWin.setTimeout?.(() => {
          this.indexAndRenderPage(reader, waivedView, pageIndex);
        }, 600);
      });

      safeRegister("textlayerrendered", (evt) => {
        const pageIndex = (evt?.pageNumber || 1) - 1;
        this.indexAndRenderPage(reader, waivedView, pageIndex);
        cleanPdfWin.setTimeout?.(() => {
          this.indexAndRenderPage(reader, waivedView, pageIndex);
        }, 150);
      });

      safeRegister("documentinit", () => {
        this.refreshPdfView(reader, waivedView);
      });

      safeRegister("pagesloaded", () => {
        this.refreshPdfView(reader, waivedView);
        cleanPdfWin.setTimeout?.(() => {
          this.refreshPdfView(reader, waivedView);
        }, 300);
      });
    }

    // Passiver Pointer-Move-Listener auf Dokument & Window für verzögerungsfreie Hover-Erkennung
    try {
      pdfDoc.addEventListener(
        "pointermove",
        (evt) => {
          this.onPdfPointerMove(reader, waivedView, cleanPdfWin, evt);
        },
        { passive: true }
      );
    } catch (_) {
      try {
        cleanPdfWin.addEventListener(
          "pointermove",
          (evt) => {
            this.onPdfPointerMove(reader, waivedView, cleanPdfWin, evt);
          },
          { passive: true }
        );
      } catch (e) {}
    }

    try {
      cleanPdfWin.addEventListener(
        "scroll",
        () => {
          this.hideTooltipImmediately(reader);
        },
        { passive: true, capture: true }
      );
    } catch (_) {}

    // Direkt alle bereits gerenderten Seiten einmal indexieren
    this.refreshPdfView(reader, waivedView);
  }

  /**
   * Aktualisiert alle offenen PDF-Reader (z. B. nach dem Anlegen/Bearbeiten/Löschen einer Definition).
   */
  refreshAllReaders() {
    const readers = Zotero.Reader?._readers || [];
    for (const reader of readers) {
      if (!reader || reader.type !== "pdf" || !reader._iframeWindow) continue;
      this.updateToolbarBadge(reader);
      const internalReader = waive(reader._internalReader);
      if (!internalReader) continue;
      const views = [internalReader._primaryView, internalReader._secondaryView].filter(
        Boolean
      );
      for (const v of views) {
        this.refreshPdfView(reader, waive(v));
      }
    }
  }

  updateToolbarBadge(reader) {
    try {
      const doc = reader?._iframeWindow?.document;
      if (!doc) return;
      const docKey = this.getDocKey(reader);
      const count = this.getActiveDefinitionsForDoc(docKey).length;
      const btns = doc.querySelectorAll("[data-zpdf-toolbar-count]");
      for (const btn of btns) {
        this.setToolbarButtonContent(btn, count);
      }
    } catch (_) {}
  }

  refreshPdfView(reader, pdfView) {
    try {
      const waivedView = waive(pdfView);
      const waivedApp = waive(waivedView?._iframeWindow?.PDFViewerApplication);
      const pages = waivedApp?.pdfViewer?._pages;
      if (!pages || typeof pages.length !== "number") return;

      for (let i = 0; i < pages.length; i++) {
        const pageView = pages[i];
        if (pageView && pageView.div) {
          const div = unwaive(pageView.div);
          const isRendered = pageView.renderingState === 3 || div.querySelector?.(".textLayer");
          if (isRendered) {
            this.indexAndRenderPage(reader, waivedView, i);
          }
        }
      }
    } catch (err) {
      this.log(`refreshPdfView Fehler: ${err}`);
    }
  }

  /**
   * Extrahiert die Zeichen einer PDF-Seite (über Zoteros `_ensureBasicPageData` + `_pdfPages[pageIndex].chars`,
   * mit Fallback auf PDF.js `getTextContent()` und DOM `.textLayer`) und legt für jedes Vorkommen
   * eines definierten Ausdrucks ein Markierungs-Element `.zpdf-def-mark` auf der Seite an.
   */
  async indexAndRenderPage(reader, pdfView, pageIndex) {
    try {
      const waivedView = waive(pdfView);
      const rawPdfWin = waivedView?._iframeWindow;
      const cleanPdfWin = unwaive(rawPdfWin);
      const waivedApp = waive(rawPdfWin?.PDFViewerApplication);
      const pages = waivedApp?.pdfViewer?._pages;
      const pageView = pages?.[pageIndex];
      if (!pageView || !pageView.div || !pageView.viewport) return;

      const pageDiv = unwaive(pageView.div);
      const pdfDoc = unwaive(cleanPdfWin?.document || pageDiv.ownerDocument);
      if (!pdfDoc) return;

      const docKey = this.getDocKey(reader);
      const activeDefs = this.getActiveDefinitionsForDoc(docKey);

      let layer = pageDiv.querySelector(":scope > .zpdf-def-layer");
      if (!activeDefs.length) {
        if (layer) layer.replaceChildren();
        return;
      }

      const scale = String(pageView.viewport.scale || 1);
      const rotation = String(pageView.viewport.rotation || 0);
      const currentStamp = `${docKey}|${this._defsStamp || 1}|${this.subtleHint ? "hint" : "nohint"}|${scale}|${rotation}`;

      if (layer && layer.dataset.zpdfIndexedStamp === currentStamp) {
        // Bereits mit aktuellem Stand & Skalierung indexiert
        return;
      }

      if (!layer) {
        layer = pdfDoc.createElement("div");
        layer.className = "zpdf-def-layer";
        pageDiv.appendChild(layer);
      }
      layer.classList.toggle("zpdf-subtle-hint", Boolean(this.subtleHint));
      layer.dataset.scale = scale;
      layer.dataset.rotation = rotation;

      // 1. Zoteros eigene Seitendaten (`_pdfPages[pageIndex].chars`) laden
      if (
        !waivedView._pdfPages?.[pageIndex]?.chars &&
        typeof waivedView._ensureBasicPageData === "function"
      ) {
        try {
          await awaitContentPromise(waivedView._ensureBasicPageData(pageIndex), rawPdfWin);
        } catch (_) {}
      }

      let chars = waivedView._pdfPages?.[pageIndex]?.chars;

      // 2. Fallback über PDF.js `pdfPage.getTextContent()`, falls `_pdfPages` noch leer ist
      if (
        (!chars || !chars.length) &&
        pageView.pdfPage &&
        typeof pageView.pdfPage.getTextContent === "function"
      ) {
        chars = await this.extractCharsFromPdfJsTextContent(pageView.pdfPage, rawPdfWin);
      }

      // 3. Fallback über den gerenderten DOM `.textLayer`
      if (!chars || !chars.length) {
        chars = this.extractCharsFromDomTextLayer(pageDiv, pageView.viewport);
      }

      if (!chars || !chars.length) {
        // Noch keine Zeichendaten verfügbar – Stempel noch nicht setzen, damit spätere Events nachladen
        return;
      }

      const matches = findMatchesInPageChars(chars, activeDefs);
      layer.replaceChildren();

      for (const m of matches) {
        for (const pdfRect of m.rects) {
          const vpRect = convertPdfRectToViewport(pageView.viewport, pdfRect);
          if (!vpRect || typeof vpRect.length !== "number" || vpRect.length < 4) continue;

          const left = Math.min(Number(vpRect[0]), Number(vpRect[2]));
          const top = Math.min(Number(vpRect[1]), Number(vpRect[3]));
          const width = Math.abs(Number(vpRect[2]) - Number(vpRect[0]));
          const height = Math.abs(Number(vpRect[3]) - Number(vpRect[1]));
          if (width <= 0 || height <= 0 || Number.isNaN(left) || Number.isNaN(top)) continue;

          const mark = pdfDoc.createElement("div");
          mark.className = "zpdf-def-mark";
          mark.style.left = `${left.toFixed(1)}px`;
          mark.style.top = `${top.toFixed(1)}px`;
          mark.style.width = `${width.toFixed(1)}px`;
          mark.style.height = `${height.toFixed(1)}px`;
          // Eindeutige ID als HTML-Attribut speichern (übersteht XrayWrappers sauber)
          mark.setAttribute("data-zpdf-def-id", m.def.id);
          mark._zpdfDef = m.def;
          layer.appendChild(mark);
        }
      }

      layer.dataset.zpdfIndexedStamp = currentStamp;
    } catch (err) {
      this.log(`indexAndRenderPage(${pageIndex}) Fehler: ${err}`);
    }
  }

  /**
   * Fallback-Konverter von PDF.js `getTextContent()` nach `chars`-Format.
   */
  async extractCharsFromPdfJsTextContent(pdfPage, contentWin) {
    try {
      const tc = await awaitContentPromise(pdfPage.getTextContent(), contentWin);
      if (!tc || !tc.items) return [];
      const chars = [];
      const items = tc.items;
      for (let itemIdx = 0; itemIdx < items.length; itemIdx++) {
        const item = items[itemIdx];
        const str = String(item.str || "");
        if (!str) continue;
        const tx = Number(item.transform?.[4] || 0);
        const ty = Number(item.transform?.[5] || 0);
        const h = Math.abs(Number(item.height || item.transform?.[3] || 10));
        const w = Math.abs(Number(item.width || str.length * (h * 0.5)));
        const charW = str.length > 0 ? w / str.length : w;

        for (let i = 0; i < str.length; i++) {
          const x1 = tx + i * charW;
          const x2 = x1 + charW;
          const rect = [x1, ty, x2, ty + h];
          chars.push({
            c: str[i],
            u: str[i],
            ignorable: false,
            spaceAfter: i === str.length - 1,
            lineBreakAfter: Boolean(item.hasEOL && i === str.length - 1),
            rect,
            inlineRect: rect,
          });
        }
      }
      return chars;
    } catch (_) {
      return [];
    }
  }

  /**
   * 3. Fallback: Liest die Zeichen direkt aus dem DOM `.textLayer` der Seite.
   */
  extractCharsFromDomTextLayer(pageDiv, viewport) {
    try {
      const textLayer = pageDiv.querySelector?.(".textLayer");
      if (!textLayer) return [];
      const spans = textLayer.children;
      if (!spans || !spans.length) return [];
      const chars = [];
      const pageRect = pageDiv.getBoundingClientRect();
      const hasConvert = typeof viewport?.convertToPdfPoint === "function";

      for (let sIdx = 0; sIdx < spans.length; sIdx++) {
        const span = spans[sIdx];
        if (!span || span.classList?.contains("endOfContent") || !span.textContent) continue;
        const text = span.textContent;
        const sRect = span.getBoundingClientRect();
        const vx1 = sRect.left - pageRect.left;
        const vy1 = sRect.top - pageRect.top;
        const vx2 = sRect.right - pageRect.left;
        const vy2 = sRect.bottom - pageRect.top;

        let pdfRect;
        if (hasConvert) {
          const p1 = viewport.convertToPdfPoint(vx1, vy2);
          const p2 = viewport.convertToPdfPoint(vx2, vy1);
          pdfRect = [
            Math.min(p1[0], p2[0]),
            Math.min(p1[1], p2[1]),
            Math.max(p1[0], p2[0]),
            Math.max(p1[1], p2[1]),
          ];
        } else {
          pdfRect = [vx1, vy1, vx2, vy2];
        }
        const w = (pdfRect[2] - pdfRect[0]) / (text.length || 1);
        for (let i = 0; i < text.length; i++) {
          const x1 = pdfRect[0] + i * w;
          const x2 = x1 + w;
          const r = [x1, pdfRect[1], x2, pdfRect[3]];
          chars.push({
            c: text[i],
            u: text[i],
            ignorable: false,
            spaceAfter: i === text.length - 1,
            lineBreakAfter: i === text.length - 1,
            rect: r,
            inlineRect: r,
          });
        }
      }
      return chars;
    } catch (_) {
      return [];
    }
  }

  /**
   * Prüft bei Mausbewegung über das PDF, ob sich der Mauszeiger über einer (unsichtbar/gepunktet)
   * markierten Stelle `.zpdf-def-mark` befindet, und blendet den Tooltip mit der Definition ein.
   */
  onPdfPointerMove(reader, pdfView, pdfWin, evt) {
    const rawEvt = unwaive(evt);
    // Während der Nutzer aktiv mit gedrückter Maustaste Text markiert, keinen Tooltip öffnen
    if (rawEvt.buttons !== 0) {
      this.hideTooltipImmediately(reader);
      return;
    }

    const clientX = rawEvt.clientX;
    const clientY = rawEvt.clientY;

    // Ziel-Element unter dem Mauszeiger sicher ermitteln (über Compartment-Grenzen hinweg)
    const rawTarget = unwaive(rawEvt.target);
    const elTarget =
      rawTarget && typeof rawTarget.closest === "function"
        ? rawTarget
        : rawTarget?.parentElement;
    const pageEl = elTarget?.closest?.(".page");
    if (!pageEl) {
      this.scheduleHideTooltip(reader, 140);
      return;
    }

    const waivedView = waive(pdfView);
    const cleanPdfWin = unwaive(pdfWin || waivedView?._iframeWindow);
    const layer = pageEl.querySelector(":scope > .zpdf-def-layer");
    const pageNum = parseInt(pageEl.getAttribute("data-page-number") || "0", 10);
    const pageView =
      pageNum > 0
        ? waive(waivedView?._iframeWindow?.PDFViewerApplication?.pdfViewer?._pages?.[pageNum - 1])
        : null;

    const scaleMismatch =
      layer &&
      pageView?.viewport &&
      (layer.dataset.scale !== String(pageView.viewport.scale || 1) ||
        layer.dataset.rotation !== String(pageView.viewport.rotation || 0));

    if (!layer || scaleMismatch || !layer.dataset.zpdfIndexedStamp) {
      // Falls Seite noch keine Layer hat oder Zoom sich geändert hat, im Hintergrund indexieren
      if (pageNum > 0 && !pageEl._zpdfIndexing) {
        pageEl._zpdfIndexing = true;
        this.indexAndRenderPage(reader, waivedView, pageNum - 1).finally(() => {
          pageEl._zpdfIndexing = false;
        });
      }
      this.scheduleHideTooltip(reader, 140);
      return;
    }

    const marks = layer.children;
    let hitMark = null;

    for (let i = 0; i < marks.length; i++) {
      const m = marks[i];
      const r = m.getBoundingClientRect();
      if (
        clientX >= r.left - 2 &&
        clientX <= r.right + 2 &&
        clientY >= r.top - 2 &&
        clientY <= r.bottom + 2
      ) {
        hitMark = m;
        break;
      }
    }

    if (reader._zpdfLastHoveredMark && reader._zpdfLastHoveredMark !== hitMark) {
      reader._zpdfLastHoveredMark.classList.remove("zpdf-def-mark-hovered");
      reader._zpdfLastHoveredMark = null;
    }

    if (!hitMark) {
      this.scheduleHideTooltip(reader, 180);
      return;
    }

    const defId = hitMark.getAttribute("data-zpdf-def-id");
    const def = (defId ? this.definitions.find((d) => d.id === defId) : null) || hitMark._zpdfDef;
    if (!def) {
      this.scheduleHideTooltip(reader, 180);
      return;
    }

    hitMark.classList.add("zpdf-def-mark-hovered");
    reader._zpdfLastHoveredMark = hitMark;
    this.showDefinitionTooltip(reader, waivedView, hitMark, def);
  }

  /**
   * Positioniert und zeigt den Definition-Tooltip in `reader._iframeWindow.document` an.
   */
  showDefinitionTooltip(reader, pdfView, markEl, def) {
    const ui = this.ensureReaderUI(reader);
    if (!ui) return;
    const { doc, tooltip } = ui;
    const rWin = reader._iframeWindow;

    if (tooltip._hideTimer) {
      rWin.clearTimeout(tooltip._hideTimer);
      tooltip._hideTimer = null;
    }

    const waivedView = waive(pdfView);
    const iframeEl = unwaive(waivedView?._iframe || waivedView?._iframeWindow?.frameElement);
    const iframeRect = iframeEl?.getBoundingClientRect
      ? iframeEl.getBoundingClientRect()
      : { left: 0, top: 0 };
    const markRect = markEl.getBoundingClientRect();

    // Inhalt nur neu aufbauen, wenn sich die angezeigte Definition geändert hat
    if (tooltip._currentDefId !== def.id || tooltip._currentUpdatedAt !== def.updatedAt) {
      tooltip._currentDefId = def.id;
      tooltip._currentUpdatedAt = def.updatedAt;
      tooltip.replaceChildren();

      const topRow = doc.createElement("div");
      topRow.className = "zpdf-tooltip-top";

      const termSpan = doc.createElement("span");
      termSpan.className = "zpdf-tooltip-term";
      termSpan.textContent = def.term;
      topRow.appendChild(termSpan);

      const scopeSpan = doc.createElement("span");
      scopeSpan.className = "zpdf-tooltip-scope";
      scopeSpan.textContent = def.scope === "global" ? "🌍 Global" : "📄 Dieses PDF";
      topRow.appendChild(scopeSpan);
      tooltip.appendChild(topRow);

      const bodyDiv = doc.createElement("div");
      bodyDiv.className = "zpdf-tooltip-body";
      bodyDiv.textContent = def.definition;
      tooltip.appendChild(bodyDiv);

      const actionsRow = doc.createElement("div");
      actionsRow.className = "zpdf-tooltip-actions";

      const scopeToggleBtn = doc.createElement("button");
      scopeToggleBtn.type = "button";
      scopeToggleBtn.className = "zpdf-tooltip-action-btn";
      scopeToggleBtn.textContent =
        def.scope === "global" ? "Nur dieses PDF" : "Global machen";
      scopeToggleBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        const docKey = this.getDocKey(reader);
        const docTitle = this.getDocTitle(reader);
        const updated = this.upsertDefinition({
          ...def,
          scope: def.scope === "global" ? "pdf" : "global",
          docKey,
          docTitle,
        });
        if (updated) {
          tooltip._currentUpdatedAt = null;
          this.showDefinitionTooltip(reader, waivedView, markEl, updated);
        }
      });
      actionsRow.appendChild(scopeToggleBtn);

      const editBtn = doc.createElement("button");
      editBtn.type = "button";
      editBtn.className = "zpdf-tooltip-action-btn";
      editBtn.textContent = "Bearbeiten";
      editBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hideTooltipImmediately(reader);
        this.openGlossaryModal(reader, def);
      });
      actionsRow.appendChild(editBtn);

      const delBtn = doc.createElement("button");
      delBtn.type = "button";
      delBtn.className = "zpdf-tooltip-action-btn zpdf-tooltip-action-danger";
      delBtn.textContent = "Löschen";
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        this.hideTooltipImmediately(reader);
        this.deleteDefinition(def.id);
      });
      actionsRow.appendChild(delBtn);

      tooltip.appendChild(actionsRow);
    }

    tooltip.hidden = false;

    // Koordinaten im Reader-Fenster berechnen
    const anchorCenterX = iframeRect.left + markRect.left + markRect.width / 2;
    const anchorTop = iframeRect.top + markRect.top;
    const anchorBottom = iframeRect.top + markRect.bottom;

    const ttRect = tooltip.getBoundingClientRect();
    const winW = rWin.innerWidth || 1000;
    const winH = rWin.innerHeight || 800;

    let left = Math.round(anchorCenterX - ttRect.width / 2);
    left = Math.max(8, Math.min(left, winW - ttRect.width - 8));

    // Standardmäßig oberhalb des Begriffs anzeigen; falls zu nah am oberen Rand, unterhalb
    let top = Math.round(anchorTop - ttRect.height - 8);
    if (top < 42) {
      top = Math.min(winH - ttRect.height - 8, Math.round(anchorBottom + 8));
    }

    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  scheduleHideTooltip(reader, delayMs = 160) {
    const rWin = reader?._iframeWindow;
    const doc = rWin?.document;
    const tooltip = doc?.getElementById("zpdf-hover-tooltip");
    if (!tooltip || tooltip.hidden) return;

    if (tooltip._hideTimer) return;
    tooltip._hideTimer = rWin.setTimeout(() => {
      tooltip._hideTimer = null;
      if (tooltip.matches(":hover")) return;
      tooltip.hidden = true;
      if (reader._zpdfLastHoveredMark) {
        reader._zpdfLastHoveredMark.classList.remove("zpdf-def-mark-hovered");
        reader._zpdfLastHoveredMark = null;
      }
    }, delayMs);
  }

  hideTooltipImmediately(reader) {
    const rWin = reader?._iframeWindow;
    const doc = rWin?.document;
    const tooltip = doc?.getElementById("zpdf-hover-tooltip");
    if (tooltip) {
      if (tooltip._hideTimer) {
        rWin.clearTimeout(tooltip._hideTimer);
        tooltip._hideTimer = null;
      }
      tooltip.hidden = true;
    }
    if (reader?._zpdfLastHoveredMark) {
      reader._zpdfLastHoveredMark.classList.remove("zpdf-def-mark-hovered");
      reader._zpdfLastHoveredMark = null;
    }
  }

  cleanupReaderDOM(reader) {
    try {
      const doc = reader?._iframeWindow?.document;
      if (doc) {
        if (doc._zpdfThemeObserver) {
          doc._zpdfThemeObserver.disconnect();
          doc._zpdfThemeObserver = null;
        }
        if (doc._zpdfMqlCleanup) {
          doc._zpdfMqlCleanup();
          doc._zpdfMqlCleanup = null;
        }
        doc.documentElement?.removeAttribute("data-zpdf-theme");
        doc.documentElement?.removeAttribute("data-zpdf-theme-mode");
        doc.documentElement?.removeAttribute("data-zpdf-contrast-card");
        doc.getElementById("zpdf-def-styles")?.remove();
        doc.getElementById("zpdf-hover-tooltip")?.remove();
        doc.getElementById("zpdf-modal-backdrop")?.remove();
        if (typeof doc.querySelectorAll === "function") {
          for (const btn of doc.querySelectorAll(".zpdf-toolbar-btn")) {
            const parentSection = btn.closest?.(".section");
            btn.remove();
            if (parentSection && parentSection.childNodes.length === 0) {
              parentSection.remove();
            }
          }
        }
      }
      const internalReader = waive(reader?._internalReader);
      const views = [internalReader?._primaryView, internalReader?._secondaryView].filter(
        Boolean
      );
      for (const v of views) {
        const uw = waive(v);
        const pDoc = unwaive(uw?._iframeWindow?.document);
        if (pDoc) {
          pDoc.documentElement?.removeAttribute("data-zpdf-theme");
          pDoc.getElementById("zpdf-inner-viewer-styles")?.remove();
          for (const el of pDoc.querySelectorAll(".zpdf-def-layer")) {
            el.remove();
          }
        }
      }
    } catch (_) {}
  }
}

// Für Services.scriptloader.loadSubScript(url, scope) in SpiderMonkey/Gecko auf `this` exportieren:
this.ZoteroPDFDefinitions = ZoteroPDFDefinitions;

// Für Unit-Tests unter Node/Python exportierbar machen
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    ZoteroPDFDefinitions,
    normalizeWhitespace,
    isWordChar,
    inferDefaultMatchOptions,
    buildSearchableTextFromChars,
    computeRectsFromCharsSlice,
    findMatchesInPageChars,
    convertPdfRectToViewport,
    unwaive,
    waive,
  };
}

#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  ZoteroPDFDefinitions,
  inferDefaultMatchOptions,
  findMatchesInPageChars,
  convertPdfRectToViewport,
} = require("./chrome/content/main.js");

function makeCharsFromLines(lines) {
  const chars = [];
  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    const y1 = 700 - lineIdx * 20;
    const y2 = y1 + 12;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === " ") {
        if (chars.length > 0) {
          chars[chars.length - 1].spaceAfter = true;
        }
        continue;
      }
      const x1 = 50 + i * 7;
      const x2 = x1 + 6;
      chars.push({
        c: ch,
        u: ch,
        ignorable: false,
        spaceAfter: false,
        lineBreakAfter: false,
        rect: [x1, y1, x2, y2],
        inlineRect: [x1, y1, x2, y2],
      });
    }
    if (chars.length > 0) {
      chars[chars.length - 1].lineBreakAfter = true;
    }
  }
  return chars;
}

// 1. Test: Intelligente Standardoptionen für Einzelbuchstaben vs. Wortgruppen
{
  const singleLetter = inferDefaultMatchOptions("E");
  assert.strictEqual(singleLetter.caseSensitive, true, "Einzelbuchstabe 'E' sollte case-sensitive sein");
  assert.strictEqual(singleLetter.wholeWord, true, "Einzelbuchstabe 'E' sollte wholeWord=true haben (nicht in 'Energie' matchen)");

  const normalWord = inferDefaultMatchOptions("Hamiltonian");
  assert.strictEqual(normalWord.caseSensitive, false, "Normales Wort sollte case-insensitive sein");
  assert.strictEqual(normalWord.wholeWord, true, "Normales Wort sollte wholeWord=true haben");

  const multiWord = inferDefaultMatchOptions("freie Energie");
  assert.strictEqual(multiWord.wholeWord, true, "Wortgruppe sollte wholeWord=true haben");
}

// 2. Test: Erkennung von Einzelbuchstaben, Wortgruppen und Zeilenumbrüchen in PDF-Seiten-Chars
{
  const chars = makeCharsFromLines([
    "Die freie",
    "Energie F = E - T S enthält E als innere Energie.",
  ]);

  const defs = [
    {
      id: "d1",
      term: "freie Energie",
      definition: "Helmholtz-Energie F",
      scope: "pdf",
      docKey: "1:ABC",
      caseSensitive: false,
      wholeWord: true,
    },
    {
      id: "d2",
      term: "E",
      definition: "Innere Energie des Systems",
      scope: "global",
      docKey: null,
      caseSensitive: true,
      wholeWord: true,
    },
  ];

  const matches = findMatchesInPageChars(chars, defs);
  const matchedTerms = matches.map((m) => m.def.term);

  // "freie\nEnergie" über Zeilenumbruch hinweg muss gefunden werden und 2 Zeilen-Rechtecke liefern
  const freieEnergieMatch = matches.find((m) => m.def.id === "d1");
  assert.ok(freieEnergieMatch, "Wortgruppe über Zeilenumbruch ('freie Energie') muss erkannt werden");
  assert.strictEqual(
    freieEnergieMatch.rects.length,
    2,
    "Wortgruppe über 2 Zeilen muss 2 Bounding-Rects erzeugen"
  );

  // "E" als freistehender Buchstabe kommt genau 2x vor ("F = E - T S enthält E als")
  // und darf NICHT das große 'E' in "Energie" matchen, weil wholeWord=true gesetzt ist!
  const eMatches = matches.filter((m) => m.def.id === "d2");
  assert.strictEqual(
    eMatches.length,
    2,
    `Freistehendes Symbol 'E' muss genau 2x erkannt werden (gefunden: ${eMatches.length})`
  );
}

// 3. Test: PDF-lokale vs. globale Definitionen im Store
{
  global.Zotero = {
    debug: () => {},
    Prefs: {
      get: () => null,
      set: () => {},
    },
    Reader: {
      _readers: [],
    },
  };

  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.0",
    rootURI: "",
  });

  addon.upsertDefinition({
    term: "α",
    definition: "Feinstrukturkonstante (global)",
    scope: "global",
    docKey: "1:PDF1",
    caseSensitive: true,
    wholeWord: false,
  });

  addon.upsertDefinition({
    term: "k_B",
    definition: "Boltzmann-Konstante (nur PDF 1)",
    scope: "pdf",
    docKey: "1:PDF1",
    caseSensitive: true,
    wholeWord: false,
  });

  const pdf1Defs = addon.getActiveDefinitionsForDoc("1:PDF1");
  const pdf2Defs = addon.getActiveDefinitionsForDoc("1:PDF2");

  assert.strictEqual(pdf1Defs.length, 2, "PDF 1 muss lokale + globale Definition sehen (2)");
  assert.strictEqual(pdf2Defs.length, 1, "PDF 2 darf nur die globale Definition sehen (1)");
  assert.strictEqual(pdf2Defs[0].term, "α");
}

// 4. Test: Darkmode / Lightmode / Auto-Erkennung & Persistenz
{
  const prefStore = new Map();
  const attrs = new Map();
  const fakeDocEl = {
    getAttribute: (k) => (attrs.has(k) ? attrs.get(k) : null),
    setAttribute: (k, v) => attrs.set(k, String(v)),
    removeAttribute: (k) => attrs.delete(k),
  };
  const fakeReader = {
    type: "pdf",
    _iframeWindow: {
      document: {
        documentElement: fakeDocEl,
      },
      matchMedia: () => ({ matches: false }),
    },
  };

  global.Zotero = {
    debug: () => {},
    Prefs: {
      get: (k) => (prefStore.has(k) ? prefStore.get(k) : null),
      set: (k, v) => prefStore.set(k, v),
    },
    Reader: {
      _readers: [fakeReader],
    },
  };

  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.3",
    rootURI: "",
  });

  // Zotero läuft im Darkmode (data-color-scheme="dark")
  attrs.set("data-color-scheme", "dark");
  addon.applyThemeToReader(fakeReader);
  assert.strictEqual(
    addon.resolveEffectiveTheme(fakeReader),
    "dark",
    "Im Auto-Modus muss Zoteros Darkmode erkannt werden"
  );
  assert.strictEqual(attrs.get("data-zpdf-theme"), "dark");
  assert.strictEqual(
    attrs.has("data-zpdf-contrast-card"),
    false,
    "Im Auto-Modus stimmt Host-Theme überein -> keine Contrast-Card nötig"
  );

  // Erster Klick im Auto-Darkmode muss sofort auf sichtbaren Lightmode wechseln
  const next1 = addon.getNextThemeMode(fakeReader);
  assert.strictEqual(next1, "light", "Erster Klick aus Auto(Dark) muss auf 'light' wechseln");
  addon.setThemeMode(next1);
  assert.strictEqual(attrs.get("data-zpdf-theme"), "light");
  assert.strictEqual(
    attrs.get("data-zpdf-contrast-card"),
    "true",
    "Manueller Lightmode in dunklem Zotero-Popup muss Contrast-Card aktivieren"
  );
  assert.strictEqual(prefStore.get("extensions.pdf-definitions.theme"), "light");

  // Manueller Wechsel auf Darkmode
  addon.setThemeMode("dark");
  assert.strictEqual(attrs.get("data-zpdf-theme"), "dark");
  assert.strictEqual(prefStore.get("extensions.pdf-definitions.theme"), "dark");
}

// 5. Test: Duplikat- & Konflikt-Erkennung (findConflictsForTerm)
{
  global.Zotero = {
    debug: () => {},
    Prefs: {
      get: () => null,
      set: () => {},
    },
    Reader: {
      _readers: [],
    },
  };

  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.4",
    rootURI: "",
  });

  addon.upsertDefinition({
    term: "Great Depression",
    definition: "Weltwirtschaftskrise ab 1929",
    scope: "global",
    docKey: "1:PDF1",
    caseSensitive: true,
    wholeWord: true,
  });

  addon.upsertDefinition({
    term: "Goldstandard",
    definition: "Währungssystem mit Goldbindung",
    scope: "pdf",
    docKey: "1:PDF1",
    docTitle: "Eichengreen (1992)",
    caseSensitive: false,
    wholeWord: true,
  });

  addon.upsertDefinition({
    term: "E",
    definition: "Innere Energie",
    scope: "global",
    docKey: "1:PDF1",
    caseSensitive: true,
    wholeWord: true,
  });

  // 1. Globale Definition ("Great Depression") muss in jedem anderen PDF (z. B. 1:PDF2) erkannt werden – auch bei Kleinschreibung
  const cGlobal = addon.findConflictsForTerm("great depression", "1:PDF2");
  assert.ok(cGlobal.globalMatch, "Globale Definition für 'Great Depression' muss erkannt werden");
  assert.strictEqual(cGlobal.globalMatch.definition, "Weltwirtschaftskrise ab 1929");
  assert.strictEqual(cGlobal.localMatch, null);

  // 2. Lokal in PDF1 definierter Begriff ("Goldstandard") wird in PDF1 als localMatch und in PDF2 als otherPdfMatches gemeldet
  const cLocal = addon.findConflictsForTerm("Goldstandard", "1:PDF1");
  assert.ok(cLocal.localMatch, "Lokale Definition in PDF1 muss als localMatch erkannt werden");

  const cOther = addon.findConflictsForTerm("Goldstandard", "1:PDF2");
  assert.strictEqual(cOther.localMatch, null);
  assert.strictEqual(cOther.globalMatch, null);
  assert.strictEqual(cOther.otherPdfMatches.length, 1, "Definition aus PDF1 muss in PDF2 als Hinweis erscheinen");
  assert.strictEqual(cOther.otherPdfMatches[0].docTitle, "Eichengreen (1992)");

  // 3. Einzelbuchstaben mit caseSensitive=true: 'E' warnt, 'e' warnt NICHT fälschlich
  const cUpperE = addon.findConflictsForTerm("E", "1:PDF2");
  assert.ok(cUpperE.globalMatch, "Einzelbuchstabe 'E' muss als bereits global definiert erkannt werden");
  const cLowerE = addon.findConflictsForTerm("e", "1:PDF2");
  assert.strictEqual(cLowerE.globalMatch, null, "Kleines 'e' darf nicht mit großem 'E' kollidieren");
}

// 6. Test: Toolbar-Button-Positionierung & Struktur (kein Umbruch im 28x28 Standard-Button)
{
  let injectedStyle = null;
  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      type: "",
      title: "",
      hidden: false,
      textContent: "",
      dataset: {},
      children: [],
      childNodes: [],
      ownerDocument: null,
      setAttribute(k, v) {
        this[k] = v;
      },
      appendChild(child) {
        this.children.push(child);
        this.childNodes.push(child);
        return child;
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
        this.childNodes = [...nodes];
      },
      addEventListener() {},
    };
    Object.defineProperty(el, "textContent", {
      get() {
        if (this.children.length > 0) {
          return this.children.map((c) => c.textContent).join("");
        }
        return this._text || "";
      },
      set(v) {
        this._text = String(v);
        this.children = [];
        this.childNodes = [];
      },
    });
    return el;
  };

  const fakeDoc = {
    documentElement: {
      getAttribute: () => "dark",
      setAttribute: () => {},
      removeAttribute: () => {},
    },
    head: {
      appendChild(el) {
        if (el.id === "zpdf-def-styles") injectedStyle = el;
      },
    },
    body: {
      appendChild() {},
    },
    getElementById(id) {
      if (id === "zpdf-def-styles") return injectedStyle;
      return null;
    },
    createElement(tag) {
      const el = makeEl(tag);
      el.ownerDocument = fakeDoc;
      return el;
    },
  };

  const fakeReader = {
    type: "pdf",
    itemID: 42,
    _iframeWindow: {
      document: fakeDoc,
      matchMedia: () => ({ matches: true }),
    },
  };

  global.Zotero = {
    debug: () => {},
    Prefs: { get: () => null, set: () => {} },
    Reader: { _readers: [fakeReader] },
  };

  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.5",
    rootURI: "",
  });

  let appendedBtn = null;
  addon.onRenderToolbar({
    reader: fakeReader,
    doc: fakeDoc,
    append: (btn) => {
      appendedBtn = btn;
    },
  });

  assert.ok(injectedStyle, "Stylesheet #zpdf-def-styles muss injiziert werden");
  assert.ok(
    injectedStyle.textContent.includes("width: auto !important;"),
    "Toolbar-Button muss Zoteros 28px-Fixbreite mit 'width: auto !important;' überschreiben"
  );
  assert.ok(
    injectedStyle.textContent.includes("white-space: nowrap !important;"),
    "Toolbar-Button muss Zeilenumbruch mit 'white-space: nowrap !important;' verhindern"
  );
  assert.ok(appendedBtn, "Toolbar-Button muss per append() eingehängt werden");
  assert.strictEqual(appendedBtn.children.length, 2, "Button muss Icon-Span und Label-Span enthalten");
  assert.strictEqual(appendedBtn.children[0].className, "zpdf-toolbar-icon");
  assert.strictEqual(appendedBtn.children[1].className, "zpdf-toolbar-label");
  assert.strictEqual(appendedBtn.textContent, "📖 Glossar (0)");
}

// 7. Test: Schutz vor Backspace-Schließen im Selection-Popup und Modal (Issue #1)
{
  const makeEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      type: "",
      title: "",
      hidden: false,
      textContent: "",
      dataset: {},
      children: [],
      childNodes: [],
      ownerDocument: null,
      _attributes: new Map(),
      setAttribute(k, v) {
        this._attributes.set(k, String(v));
        this[k] = v;
      },
      getAttribute(k) {
        return this._attributes.get(k) || null;
      },
      appendChild(child) {
        this.children.push(child);
        this.childNodes.push(child);
        return child;
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
        this.childNodes = [...nodes];
      },
      addEventListener() {},
      classList: {
        add(c) {
          if (!el.className.includes(c)) el.className += " " + c;
        },
        remove(c) {
          el.className = el.className.replace(new RegExp(`\\b${c}\\b`, "g"), "").trim();
        },
        toggle(c, state) {
          if (state) this.add(c);
          else this.remove(c);
        },
        contains(c) {
          return el.className.includes(c);
        },
      },
    };
    return el;
  };

  const fakeDoc = {
    documentElement: {
      getAttribute: () => "light",
      setAttribute: () => {},
      removeAttribute: () => {},
    },
    head: { appendChild() {} },
    body: { appendChild() {} },
    getElementById: () => null,
    createElement(tag) {
      const el = makeEl(tag);
      el.ownerDocument = fakeDoc;
      return el;
    },
  };

  const fakeReader = {
    type: "pdf",
    itemID: 101,
    _item: { libraryID: 1, key: "AUC4RVJM", getDisplayTitle: () => "Test Document" },
    _iframeWindow: {
      document: fakeDoc,
      matchMedia: () => ({ matches: false }),
    },
  };

  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.6",
    rootURI: "",
  });

  let selectionBox = null;
  addon.onRenderTextSelectionPopup({
    reader: fakeReader,
    doc: fakeDoc,
    params: { annotation: { text: "Inflation" } },
    append: (box) => {
      selectionBox = box;
    },
  });

  assert.ok(selectionBox, "Selection-Box muss gerendert werden");
  assert.ok(
    selectionBox.className.includes("label-popup") && selectionBox.className.includes("preview-popup"),
    "Selection-Box muss .label-popup und .preview-popup Klassen besitzen, damit Zoteros KeyboardManager kein deleteAnnotations aufruft"
  );

  const termInput = selectionBox.children.find((c) => c.className === "zpdf-input");
  const defInput = selectionBox.children.find((c) => c.className === "zpdf-textarea");
  assert.ok(termInput, "Term-Input muss vorhanden sein");
  assert.ok(defInput, "Def-Input muss vorhanden sein");
  assert.strictEqual(
    termInput.getAttribute("contenteditable"),
    "true",
    "Term-Input muss contenteditable='true' besitzen (Zotero FocusManager Schutz)"
  );
  assert.strictEqual(
    defInput.getAttribute("contenteditable"),
    "true",
    "Def-Textarea muss contenteditable='true' besitzen (Zotero FocusManager Schutz)"
  );
}

// 8. Test: Hover-Erkennung, Viewport-Transformation und Markierungs-Rendering (Issue #2)
{
  // 1. Viewport Transform Matrix [scaleX, skewY, skewX, scaleY, transX, transY]
  const viewport = {
    transform: [1.5, 0, 0, -1.5, 0, 1000],
    scale: 1.5,
    rotation: 0,
  };
  const pdfRect = [100, 200, 150, 220]; // [x1, y1, x2, y2]
  const vpRect = convertPdfRectToViewport(viewport, pdfRect);
  assert.ok(vpRect, "convertPdfRectToViewport muss ein Ergebnis liefern");
  assert.strictEqual(vpRect[0], 100 * 1.5 + 0, "x1 korrekt skaliert");
  assert.strictEqual(vpRect[1], 200 * -1.5 + 1000, "y1 korrekt invertiert/verschoben");
  assert.strictEqual(vpRect[2], 150 * 1.5 + 0, "x2 korrekt skaliert");
  assert.strictEqual(vpRect[3], 220 * -1.5 + 1000, "y2 korrekt invertiert/verschoben");

  // 2. indexAndRenderPage mit Definition und subtleHint
  const addon = new ZoteroPDFDefinitions({
    id: "pdf-definitions@zotero-addon.local",
    version: "1.0.6",
    rootURI: "",
  });
  addon.subtleHint = true;
  addon.upsertDefinition({
    id: "def_test_alp",
    term: "ALP",
    definition: "American Life Panel",
    scope: "pdf",
    docKey: "1:AUC4RVJM",
    caseSensitive: true,
    wholeWord: true,
  });

  const chars = [
    { c: "A", u: "A", ignorable: false, rect: [100, 200, 110, 220], inlineRect: [100, 200, 110, 220] },
    { c: "L", u: "L", ignorable: false, rect: [110, 200, 120, 220], inlineRect: [110, 200, 120, 220] },
    { c: "P", u: "P", ignorable: false, spaceAfter: true, rect: [120, 200, 130, 220], inlineRect: [120, 200, 130, 220] },
  ];

  const makeMockEl = (tag) => {
    const el = {
      tagName: tag.toUpperCase(),
      id: "",
      className: "",
      style: {},
      dataset: {},
      children: [],
      childNodes: [],
      _attrs: new Map(),
      setAttribute(k, v) {
        this._attrs.set(k, String(v));
      },
      getAttribute(k) {
        return this._attrs.get(k) || null;
      },
      appendChild(c) {
        this.children.push(c);
        this.childNodes.push(c);
        return c;
      },
      replaceChildren(...nodes) {
        this.children = [...nodes];
        this.childNodes = [...nodes];
      },
      querySelector(sel) {
        if (sel.includes(".zpdf-def-layer")) {
          return this.children.find((c) => c.className.includes("zpdf-def-layer")) || null;
        }
        return null;
      },
      classList: {
        add(c) {
          if (!el.className.includes(c)) el.className += " " + c;
        },
        remove(c) {
          el.className = el.className.replace(new RegExp(`\\b${c}\\b`, "g"), "").trim();
        },
        toggle(c, state) {
          if (state) this.add(c);
          else this.remove(c);
        },
      },
    };
    return el;
  };

  const mockPdfDoc = {
    createElement: makeMockEl,
  };
  const pageDiv = makeMockEl("div");
  pageDiv.className = "page";
  pageDiv.ownerDocument = mockPdfDoc;

  const mockPageView = {
    div: pageDiv,
    viewport,
  };

  const mockPdfView = {
    _pdfPages: [{ chars }],
    _iframeWindow: {
      document: mockPdfDoc,
      PDFViewerApplication: {
        pdfViewer: {
          _pages: [mockPageView],
        },
      },
    },
  };

  const fakeReader = {
    type: "pdf",
    itemID: 101,
    _item: { libraryID: 1, key: "AUC4RVJM", getDisplayTitle: () => "Test Document" },
    _iframeWindow: {
      document: {
        documentElement: { getAttribute: () => "light" },
        getElementById: () => null,
      },
    },
  };

  addon.indexAndRenderPage(fakeReader, mockPdfView, 0);

  const layer = pageDiv.querySelector(".zpdf-def-layer");
  assert.ok(layer, "Layer .zpdf-def-layer muss im Page-Div angelegt werden");
  assert.ok(
    layer.className.includes("zpdf-subtle-hint"),
    "Layer muss Klasse zpdf-subtle-hint besitzen wenn subtleHint aktiv ist"
  );
  assert.strictEqual(layer.children.length, 1, "Genau ein Markierungselement für 'ALP' muss existieren");

  const mark = layer.children[0];
  assert.strictEqual(mark.className, "zpdf-def-mark");
  assert.strictEqual(
    mark.getAttribute("data-zpdf-def-id"),
    "def_test_alp",
    "Markierung muss data-zpdf-def-id Attribut mit der Definitions-ID besitzen"
  );
  assert.ok(parseFloat(mark.style.width) > 0, "Markierungsbreite muss > 0 sein");
  assert.ok(parseFloat(mark.style.height) > 0, "Markierungshöhe muss > 0 sein");
}

console.log("Alle Add-on Tests erfolgreich bestanden (OK).");

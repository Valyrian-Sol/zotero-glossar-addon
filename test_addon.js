#!/usr/bin/env node
"use strict";

const assert = require("assert");
const {
  ZoteroPDFDefinitions,
  inferDefaultMatchOptions,
  findMatchesInPageChars,
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

console.log("Alle Add-on Tests erfolgreich bestanden (OK).");

# Zotero Add-on: PDF Glossar & Definitionen (`zotero-pdf-definitions.xpi`)

> **🤖 Hinweis (KI-Projekt):** Dieses Projekt wurde mithilfe künstlicher Intelligenz (KI-gestützte Entwicklung) konzipiert und erstellt.

Ein Zotero-Add-on (kompatibel mit Zotero 8, 9, 10 und 11), mit dem direkt im eingebauten PDF-Reader **Buchstaben, mathematische Ausdrücke, Abkürzungen oder ganze Wortgruppen** markiert, definiert und per Maus-Hover nachgeschlagen werden können.

## Funktionen

1. **Direkt beim Markieren im PDF definieren:**
   - Sobald in einem PDF ein Buchstabe (z. B. `E`, `α`), ein Ausdruck oder eine Wortgruppe markiert wird, erscheint im Auswahl-Popup der Bereich **„📖 Ausdruck definieren“**.
   - Dort kann die Definition eingegeben und mit **Definieren** (oder `Strg+Enter`) gespeichert werden.
2. **Unsichtbare Markierung & Hover-Tooltip:**
   - Jedes weitere Vorkommen des definierten Ausdrucks im PDF (auch wenn eine Wortgruppe über einen Zeilenumbruch getrennt ist!) wird **unsichtbar markiert**.
   - Sobald der Mauszeiger über eine solche Stelle fährt (**Hover**), wird die Stelle leicht hervorgehoben und ein **Tooltip mit der Definition** eingeblendet.
   - Im Tooltip lässt sich die Definition auch direkt bearbeiten, löschen oder zwischen *Lokal* und *Global* umschalten.
3. **Lokal (nur dieses PDF) oder Global (alle PDFs in Zotero):**
   - Über das Häkchen **„🌍 Global (alle PDFs)“** wird festgelegt, ob die Definition nur für das aktuelle PDF gilt oder automatisch in **allen PDFs** der gesamten Zotero-Bibliothek aktiv ist.
4. **Glossar-Manager in der PDF-Toolbar (`📖 Glossar (N)`):**
   - Rechts oben in der PDF-Reader-Werkzeugleiste befindet sich der Button **„📖 Glossar“**.
   - Darüber lassen sich alle Definitionen durchsuchen, bearbeiten, neu anlegen oder optional eine dezente gepunktete Unterstreichung ein-/ausschalten (standardmäßig sind alle Markierungen komplett unsichtbar).
5. **Darkmode & Lightmode (inkl. Auto-Erkennung):**
   - Erkennt automatisch Zoteros aktuelles Farbschema (Hell/Dunkel).
   - Zusätzlich kann jederzeit direkt oben rechts im Auswahl-Popup (`🌓 Auto` / `🌙 Dark` / `☀️ Hell`) oder im Glossar-Dialog unter **„🎨 Erscheinungsbild“** manuell zwischen **Automatisch**, **Darkmode** und **Lightmode** umgeschaltet werden.

---

## Installation in Zotero

Die fertige `.xpi`-Datei liegt direkt im Repository unter [`zotero-pdf-definitions.xpi`](zotero-pdf-definitions.xpi).

1. Öffne **Zotero**.
2. Gehe im oberen Menü auf **Extras → Add-ons** (bzw. **Tools → Plugins**).
3. Klicke oben rechts auf das **Zahnrad-Symbol ⚙️** und wähle **„Add-on aus Datei installieren…“** (*Install Plugin From File…*).
4. Wähle die Datei `zotero-pdf-definitions.xpi` aus.
5. Das Add-on ist sofort aktiv (kein Neustart nötig).

## Neu bauen & Tests ausführen

```bash
git clone https://github.com/Valyrian-Sol/zotero-glossar-addon.git
cd zotero-glossar-addon

# .xpi Paket neu bauen
python3 build.py

# Unit-Tests ausführen
node test_addon.js
```

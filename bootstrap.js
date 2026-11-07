/* global Zotero, Services, Components, ChromeUtils, IOUtils, PathUtils, setTimeout, clearTimeout, setInterval, clearInterval */
"use strict";

var pdfDefinitionsInstance = null;

function logError(msg, err) {
  let full = `[PDF-Definitions] ${msg}: ${
    err instanceof Error ? `${err.message}\n${err.stack || ""}` : String(err || "")
  }`;
  try {
    let scriptError = Components.classes["@mozilla.org/scripterror;1"].createInstance(
      Components.interfaces.nsIScriptError
    );
    scriptError.init(
      full,
      "bootstrap.js",
      0,
      0,
      scriptError.errorFlag,
      "system javascript",
      false,
      true
    );
    Services.console.logMessage(scriptError);
  } catch (_) {}
  try {
    Zotero.debug(full, 1);
    Zotero.logError(full);
  } catch (_) {}
}

function install(data, reason) {}

function uninstall(data, reason) {}

function startup({ id, version, rootURI }, reason) {
  try {
    let scope = {
      Zotero,
      Services,
      Components,
      ChromeUtils,
      IOUtils,
      PathUtils,
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
    };
    Services.scriptloader.loadSubScript(`${rootURI}main.js`, scope);
    let AddonClass = scope.ZoteroPDFDefinitions;
    if (!AddonClass) {
      throw new Error("main.js did not expose ZoteroPDFDefinitions on the load scope");
    }
    pdfDefinitionsInstance = new AddonClass({ id, version, rootURI });
    pdfDefinitionsInstance.startup(reason).catch((err) => {
      logError("Startup error", err);
    });
  } catch (err) {
    logError("Startup error", err);
  }
}

function shutdown(data, reason) {
  let inst = pdfDefinitionsInstance;
  pdfDefinitionsInstance = undefined;
  inst?.shutdown(reason).catch((err) => {
    logError("Shutdown error", err);
  });
}

function onMainWindowLoad({ window }) {
  pdfDefinitionsInstance?.onMainWindowLoad(window);
}

function onMainWindowUnload({ window }) {
  pdfDefinitionsInstance?.onMainWindowUnload(window);
}

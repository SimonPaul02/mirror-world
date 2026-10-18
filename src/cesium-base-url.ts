/**
 * Tells Cesium where its static runtime assets live.
 *
 * Imported FIRST in main.ts, before the `cesium` module itself, so the widget
 * bundle can resolve Workers/, Assets/, Widgets/ and ThirdParty/ — which
 * scripts/copy-cesium-assets.mjs copies into public/cesium on install.
 */
declare global {
  interface Window {
    CESIUM_BASE_URL?: string;
  }
}

window.CESIUM_BASE_URL = `${import.meta.env.BASE_URL}cesium/`;

export {};

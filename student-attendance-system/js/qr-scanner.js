(function () {
  'use strict';

  let html5QrCode = null;
  let running = false;
  let currentOnScan = null;
  let currentOnError = null;

  function mountPoint() {
    return document.getElementById('qrRegion');
  }

  function cameraError(error) {
    const text = String(error && (error.message || error));
    const mapped = new Error(text || 'Camera unavailable.');
    mapped.name = String(error && error.name ? error.name : 'CameraError');
    mapped.code = /permission|denied|notallowed/i.test(text) ? 'permission-denied' : 'device-error';
    return mapped;
  }

  window.QrScanner = {
    start: function (onScan, onError) {
      currentOnScan = onScan;
      currentOnError = onError;

      if (running) return Promise.resolve();

      const target = mountPoint();
      if (!target) return Promise.reject(new Error('QR scanner mount point missing.'));
      if (!window.Html5Qrcode || !window.Html5Qrcode.getCameras) {
        return Promise.reject(new Error('QR scanner library failed to load.'));
      }

      return window.Html5Qrcode.getCameras().then(function (cameras) {
        if (!cameras || !cameras.length) throw new Error('No cameras found.');

        html5QrCode = new window.Html5Qrcode(target.id || 'qrRegion');
        return html5QrCode.start(
          cameras[0].id,
          { fps: 10, qrbox: 250 },
          function (decodedText) {
            if (!decodedText || !currentOnScan) return;
            try { currentOnScan(String(decodedText)); }
            catch (error) { console.error('[QrScanner] Scan handler failed:', error); }
          },
          function () {}
        ).then(function () {
          running = true;
        });
      }).catch(function (error) {
        running = false;
        if (html5QrCode) {
          try { html5QrCode.clear(); } catch (clearError) {}
        }
        html5QrCode = null;
        throw cameraError(error);
      });
    },

    stop: function () {
      running = false;
      currentOnScan = null;
      currentOnError = null;
      if (!html5QrCode) return Promise.resolve();

      const scanner = html5QrCode;
      html5QrCode = null;
      return scanner.stop().catch(function () {}).then(function () {
        try { scanner.clear(); } catch (error) {}
      });
    },

    isRunning: function () { return running; }
  };
})();

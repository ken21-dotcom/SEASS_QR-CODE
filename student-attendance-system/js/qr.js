/* ============================================================
   Student QR Renderer
   ------------------------------------------------------------
   Dynamically loads the lightweight qrcode.js CDN library and
   draws the event-scoped student QR token into a canvas element.
   ============================================================ */

(function () {
  'use strict';

  // Local browser bundle: QR generation works without internet access.
  let loadingPromise = null;

  function qrScriptUrl() {
    if (document.currentScript && document.currentScript.src) {
      return new URL('vendor/qrcode.min.js', document.currentScript.src).href;
    }
    return new URL('js/vendor/qrcode.min.js', window.location.origin).href;
  }

  function loadQrLibrary() {
    if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
      return Promise.resolve(window.QRCode);
    }
    if (loadingPromise) {
      return loadingPromise;
    }

    loadingPromise = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = qrScriptUrl();
      script.async = true;
      script.onload = () => {
        if (window.QRCode && typeof window.QRCode.toCanvas === 'function') {
          resolve(window.QRCode);
        } else {
          reject(new Error('The local QR library is not the browser build.'));
        }
      };
      script.onerror = () => {
        loadingPromise = null;
        reject(new Error('Failed to load QR code rendering library.'));
      };
      document.head.appendChild(script);
    });

    return loadingPromise;
  }

  /**
   * Renders a QR code for a student token into a container element.
   *
   * @param {string} containerId ID of the element to host the canvas
   * @param {string|null} token The signed token for the selected event
   * @param {number} [size=160] Rendered canvas width/height in pixels
   */
  window.renderStudentQr = function (containerId, token, size) {
    const el = document.getElementById(containerId);
    if (!el) return;

    // Default matches the dashboard thumbnail; the enlarge modal asks for a
    // larger square so the kiosk camera can read it from further away.
    const dimension = Number(size) > 0 ? Math.round(Number(size)) : 350;

    if (!token || typeof token !== 'string') {
      el.innerHTML = '<p class="text-muted small my-auto">Select an event to generate your check-in QR code.</p>';
      return;
    }

    el.innerHTML = '<span class="text-muted small">Loading code…</span>';

    loadQrLibrary()
      .then((QRCode) => {
        const canvas = document.createElement('canvas');
        QRCode.toCanvas(
          canvas,
          token,
          {
            width: dimension,
            margin: 1,
            errorCorrectionLevel: 'L',
            correctLevel: 'L',
            color: {
              dark: '#000000',
              light: '#FFFFFF',
            },
          },
          (err) => {
            if (err) {
              el.innerHTML = '<p class="text-danger small my-auto">Failed to render QR code.</p>';
              return;
            }
            el.innerHTML = '';
            el.appendChild(canvas);
          }
        );
      })
      .catch(() => {
        el.innerHTML = '<p class="text-muted small my-auto">QR library could not be loaded.</p>';
      });
  };
})();
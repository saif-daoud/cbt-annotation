// API location. Locally the Node preview server (worker/local_server.mjs) serves the site and API on port 8787.
(function () {
  var local = ["localhost", "127.0.0.1"].indexOf(window.location.hostname) >= 0;
  window.APP_CONFIG = {
    apiBase: local
      ? (window.location.port === "8787" ? window.location.origin : "http://127.0.0.1:8787")
      : "https://cbt-annotation-api.saif-sedaoud.workers.dev"
  };
})();

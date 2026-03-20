window.onload = function() {
  //<editor-fold desc="Changeable Configuration Block">
  const originalHash = window.location.hash;
  // the following lines will be replaced by docker/configurator, when it runs in a docker-container
  window.ui = SwaggerUIBundle({
    url: "arc.json",
    dom_id: '#swagger-ui',
    deepLinking: true,
    presets: [
      SwaggerUIBundle.presets.apis,
      SwaggerUIStandalonePreset
    ],
    plugins: [
      SwaggerUIBundle.plugins.DownloadUrl
    ],
    layout: "BaseLayout",
    supportedSubmitMethods: []
  });

  if (originalHash.startsWith("#model-")) {
    setTimeout(() => {
      window.location.hash = originalHash;
    }, 500);
  }
};

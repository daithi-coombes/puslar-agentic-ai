// ~/.pulsar/packages/your-plugin/templates/default.js
module.exports = function(context, query) {
  return `Context:
${context}

Question: ${query}

Answer:`;
};

// In your prompt loader
const templateName = modelConfig.template;
const templatePath = path.join(configDir, 'templates', `${templateName}.js`);
const templateFn = require(templatePath);
const prompt = templateFn(context, query);

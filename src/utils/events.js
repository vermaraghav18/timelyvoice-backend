const EventEmitter = require('events');
const bus = new EventEmitter();

exports.emitEvent = (name, payload) => bus.emit(name, payload);
exports.onEvent = (name, handler) => bus.on(name, handler);

// Example consumer:
const { onEvent } = require('./events');
onEvent('article.published', ({ id }) => {
  // TODO: purge cache/CDN or recompute sitemap in Phase 2
  console.log('article.published', id);
});

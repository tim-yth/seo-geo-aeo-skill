export default {
  async fetch(request, env) {
    const res = await env.ASSETS.fetch(request);
    return new HTMLRewriter().on('head', { element(el) { el.append('<!-- tag -->', { html: true }); } }).transform(res);
  },
};

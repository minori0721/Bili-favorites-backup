import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: false, linkify: false, typographer: false, maxNesting: 12 });
markdown.disable(["table"]);
markdown.validateLink = (href: string) => {
  try {
    const url = new URL(href);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password;
  } catch { return false; }
};
markdown.renderer.rules.image = (tokens, index) => markdown.utils.escapeHtml(tokens[index].content);
markdown.renderer.rules.link_open = (tokens, index, options, env, renderer) => {
  tokens[index].attrSet("target", "_blank");
  tokens[index].attrSet("rel", "noopener noreferrer");
  return renderer.renderToken(tokens, index, options);
};
markdown.renderer.rules.heading_open = (tokens, index) => tokens[index].tag === "h1" || tokens[index].tag === "h2" ? "<h3>" : `<${tokens[index].tag}>`;
markdown.renderer.rules.heading_close = (tokens, index) => tokens[index].tag === "h1" || tokens[index].tag === "h2" ? "</h3>\n" : `</${tokens[index].tag}>\n`;

export function renderReleaseNotes(notes: string): string {
  return markdown.render(notes.slice(0, 24000));
}

export function requireElement<T extends Element>(root: ParentNode, selector: string, type: {new(...args: never[]): T}): T {
  const element = root.querySelector(selector);
  if (!(element instanceof type)) throw new Error('Missing or invalid UI element: ' + selector);
  return element;
}

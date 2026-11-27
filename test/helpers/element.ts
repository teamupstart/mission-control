import { createElement, type ComponentType, type ReactElement, type ReactNode } from "react";

/**
 * `createElement` with the children passed as children, the way JSX passes them, rather than
 * as a `children` prop (`react/no-children-prop`).
 *
 * React's overloads take the props type from the second argument alone, so a component that
 * declares `children` as required cannot be called with them in the third. This keeps the
 * call site checked against the component's own props: every prop but `children` in `props`,
 * and `children` typed as the component declares it.
 */
export function withChildren<P extends { children?: unknown }>(
  type: ComponentType<P>,
  props: Omit<P, "children">,
  children: P["children"],
): ReactElement<P> {
  return createElement(type, props as P, children as ReactNode);
}

function name(node, computed = false) {
  if (!computed && node?.type === "Identifier") return node.name;
  if (node?.type === "Literal") return node.value;
  if (node?.type === "TemplateLiteral" && node.expressions.length === 0) {
    return node.quasis[0].value.cooked;
  }
}

function member(node, property) {
  return node?.type === "MemberExpression" && name(node.property, node.computed) === property;
}

const agentNames = new Set(["claude", "codex", "pi"]);
const equalityOperators = new Set(["===", "!==", "==", "!="]);
const testLibraries = /^(?:jsdom|@testing-library|vitest|@vitest|jest|@jest)(?:\/|$)|^jest-/;

export default {
  meta: { name: "repository" },
  rules: {
    "test-imports": {
      create(context) {
        function check(node) {
          const specifier = name(node, true);
          if (specifier === "node:assert" || specifier === "assert") {
            context.report({ node, message: "Use node:assert/strict in tests." });
          } else if (typeof specifier === "string" && testLibraries.test(specifier)) {
            context.report({ node, message: "Use node:test, static React rendering, or the repository's Playwright suite." });
          }
        }
        return {
          ImportDeclaration: (node) => check(node.source),
          ExportNamedDeclaration: (node) => check(node.source),
          ExportAllDeclaration: (node) => check(node.source),
          ImportExpression: (node) => check(node.source),
          TSExternalModuleReference: (node) => check(node.expression),
          CallExpression(node) {
            if (name(node.callee) === "require") check(node.arguments[0]);
          },
        };
      },
    },
    "no-test-ids": {
      create(context) {
        function check(node, value) {
          if (value === "getByTestId" || value === "data-testid" ||
              (typeof value === "string" && /\[\s*data-testid(?:\s|[~|^$*!=\]])/i.test(value))) {
            context.report({ node, message: "Use accessible roles, labels, or placeholders instead of test IDs." });
          }
        }
        return {
          JSXAttribute: (node) => check(node, node.name.name),
          CallExpression(node) {
            if (node.callee.type === "Identifier") check(node.callee, node.callee.name);
          },
          MemberExpression: (node) => check(node, name(node.property, node.computed)),
          Property: (node) => check(node, name(node.key, node.computed)),
          Literal: (node) => {
            // Quoted keys and member names are handled by their enclosing node.
            if (node.parent?.key !== node && node.parent?.property !== node) check(node, node.value);
          },
          TemplateLiteral: (node) => {
            if (node.parent?.key !== node && node.parent?.property !== node) {
              for (const quasi of node.quasis) check(quasi, quasi.value.cooked);
            }
          },
        };
      },
    },
    "parse-request-body": {
      create(context) {
        return {
          CallExpression(node) {
            if (member(node.callee, "json") && member(node.callee.object, "req")) {
              context.report({ node, message: "Parse request JSON through src/server/http-body.ts." });
            }
          },
        };
      },
    },
    "agent-comparison": {
      create(context) {
        function report(node) {
          context.report({ node, message: "Use a harness capability or put agent-specific comparisons in src/server/harness/." });
        }
        return {
          BinaryExpression(node) {
            if (equalityOperators.has(node.operator) &&
                (agentNames.has(name(node.left, true)) || agentNames.has(name(node.right, true)))) report(node);
          },
          SwitchCase(node) {
            if (agentNames.has(name(node.test, true))) report(node.test);
          },
        };
      },
    },
    "registry-eviction": {
      create(context) {
        function report(node) {
          context.report({ node, message: "Registry owns session removal. Use Registry.beginEviction." });
        }
        return {
          CallExpression(node) {
            if (member(node.callee, "delete") &&
                (name(node.callee.object) === "sessions" || member(node.callee.object, "sessions"))) report(node);
          },
          Property(node) {
            if (node.parent.type !== "ObjectExpression" || name(node.key, node.computed) !== "type") return;
            let value = node.value;
            while (value.type === "TSAsExpression" || value.type === "TSSatisfiesExpression") {
              value = value.expression;
            }
            if (name(value, true) === "session_remove") report(node);
          },
        };
      },
    },
  },
};

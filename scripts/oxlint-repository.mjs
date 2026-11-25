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

function bindingIdentifier(context, node) {
  if (node?.type !== "Identifier") return;
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const binding = scope.set.get(node.name);
    if (binding) return binding.defs[0]?.name;
  }
}

function annotation(identifier) {
  const type = identifier?.typeAnnotation?.typeAnnotation;
  return type?.type === "TSTypeReference" ? name(type.typeName) : undefined;
}

function matchesLocalValue(context, node, matches) {
  const seen = new Set();
  while (node && !seen.has(node)) {
    seen.add(node);
    const binding = bindingIdentifier(context, node);
    if (matches(node, binding)) return true;
    const declaration = binding?.parent;
    if (declaration?.type !== "VariableDeclarator" || declaration.id !== binding ||
        declaration.parent.kind !== "const") break;
    node = declaration.init;
  }
  return false;
}

const agentOperands = new Set(["agent", "agentType", "runner"]);
function selectsAgent(context, node) {
  return matchesLocalValue(context, node, (value, binding) =>
    agentOperands.has(name(value)) ||
    (value.type === "MemberExpression" && agentOperands.has(name(value.property, value.computed))) ||
    annotation(binding) === "AgentType");
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
            if (!member(node.callee, "json")) return;
            const isRequest = matchesLocalValue(context, node.callee.object, (value, binding) => {
              const property = binding?.parent;
              return member(value, "req") || (property?.type === "Property" &&
                property.parent.type === "ObjectPattern" && property.value === binding &&
                name(property.key, property.computed) === "req");
            });
            if (isRequest) {
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
            if (!equalityOperators.has(node.operator)) return;
            if ((agentNames.has(name(node.left, true)) && selectsAgent(context, node.right)) ||
                (agentNames.has(name(node.right, true)) && selectsAgent(context, node.left))) report(node);
          },
          SwitchCase(node) {
            if (agentNames.has(name(node.test, true)) && selectsAgent(context, node.parent.discriminant)) report(node.test);
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
            if (!member(node.callee, "delete")) return;
            const isRegistryMap = matchesLocalValue(context, node.callee.object, (value) => {
              if (!member(value, "sessions")) return false;
              const owner = value.object;
              const ownerType = annotation(bindingIdentifier(context, owner));
              return ownerType === "Registry" || (!ownerType && (name(owner) === "registry" || member(owner, "registry")));
            });
            if (isRegistryMap) report(node);
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

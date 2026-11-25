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

function localBinding(context, node) {
  if (node?.type !== "Identifier") return;
  for (let scope = context.sourceCode.getScope(node); scope; scope = scope.upper) {
    const binding = scope.set.get(node.name);
    if (binding) return binding;
  }
}

function annotation(identifier) {
  const type = identifier?.typeAnnotation?.typeAnnotation;
  return type?.type === "TSTypeReference" ? name(type.typeName) : undefined;
}

function hasRegistrySessions(binding) {
  const type = binding?.typeAnnotation?.typeAnnotation;
  if (type?.type !== "TSTypeReference") return false;
  if (name(type.typeName) === "Registry") return true;
  if (name(type.typeName) !== "Pick") return false;
  const [source, keys] = type.typeArguments?.params ?? [];
  if (source?.type !== "TSTypeReference" || name(source.typeName) !== "Registry") return false;
  const members = keys?.type === "TSUnionType" ? keys.types : [keys];
  return members.some((key) => key?.type === "TSLiteralType" && name(key.literal, true) === "sessions");
}

function isLaterWrite(node, write, declarationBlock, statement) {
  if (statement.range[1] <= write.range[0]) return true;
  // A nested conditional or plain block executes at most once per entry to
  // the declaration block. A loop body can carry a later write into its next use.
  let inner = node;
  while (inner !== statement && inner.parent.type !== "BlockStatement") inner = inner.parent;
  if (inner === statement || inner.range[1] > write.range[0]) return false;
  const block = inner.parent;
  if (write.range[1] > block.range[1]) return false;
  for (let container = block; container !== declarationBlock; container = container.parent) {
    if (container.type !== "BlockStatement" && container.type !== "IfStatement") return false;
  }
  return true;
}

function reachingAssignments(context, node, variable, declaration) {
  const block = declaration.parent.parent;
  let statement = node;
  while (statement.parent && statement.parent !== block) statement = statement.parent;
  const useScope = context.sourceCode.getScope(node).variableScope;
  let latest;
  const possible = [];
  for (const reference of variable.references) {
    if (!reference.isWrite() || reference.init) continue;
    const identifier = reference.identifier;
    const sameBlock = (block.type === "BlockStatement" || block.type === "Program") &&
      statement.parent === block && identifier.range[0] >= block.range[0] &&
      identifier.range[1] <= block.range[1] && reference.from.variableScope === useScope &&
      variable.scope.variableScope === useScope;
    if (sameBlock && isLaterWrite(node, identifier, block, statement)) continue;
    const assignment = identifier.parent;
    if (assignment.type !== "AssignmentExpression" || assignment.operator !== "=" || assignment.left !== identifier) continue;
    const writeBlock = assignment.parent.parent;
    let use = node;
    while (use !== statement && use.parent !== writeBlock) use = use.parent;
    if (sameBlock && assignment.parent.type === "ExpressionStatement" &&
        (writeBlock.type === "BlockStatement" || writeBlock.type === "Program") &&
        use.parent === writeBlock && assignment.range[1] <= use.range[0]) {
      if (!latest || latest.range[0] < assignment.range[0]) latest = assignment;
    } else {
      possible.push({ assignment, sameBlock });
    }
  }
  // A conditional write can leave the prior value in place. Only a definite
  // overwrite displaces it.
  const values = possible
    .filter(({ assignment, sameBlock }) => !latest || !sameBlock || assignment.range[0] > latest.range[0])
    .map(({ assignment }) => assignment.right);
  if (latest) values.push(latest.right);
  return { values, overwritten: latest !== undefined };
}

function matchesLocalValue(context, initial, matches, matchesDeclaredType) {
  const seen = new Set();
  const pending = [initial];
  while (pending.length > 0) {
    const node = pending.pop();
    if (!node || seen.has(node)) continue;
    seen.add(node);
    if (node.type === "TSAsExpression" || node.type === "TSSatisfiesExpression" || node.type === "TSNonNullExpression") {
      pending.push(node.expression);
      continue;
    }
    const variable = localBinding(context, node);
    const definition = variable?.defs[0];
    const binding = definition?.name;
    const declaration = definition?.node;
    if (matchesDeclaredType?.(binding)) return true;
    if (declaration?.type === "VariableDeclarator" && declaration.parent.kind !== "const") {
      const { values, overwritten } = reachingAssignments(context, node, variable, declaration);
      pending.push(...values);
      if (overwritten) continue;
    }
    if (matches(node, binding)) return true;
    if (declaration?.type === "VariableDeclarator" && declaration.id === binding) pending.push(declaration.init);
  }
  return false;
}

const agentOperands = new Set(["agent", "agentType", "runner"]);
function selectsAgent(context, node) {
  return matchesLocalValue(context, node, (value, binding) => {
    const property = binding?.parent;
    return agentOperands.has(name(value)) ||
      (value.type === "MemberExpression" && agentOperands.has(name(value.property, value.computed))) ||
      (property?.type === "Property" && property.parent.type === "ObjectPattern" &&
        property.value === binding && agentOperands.has(name(property.key, property.computed)));
  }, (binding) => annotation(binding) === "AgentType");
}

const agentNames = new Set(["claude", "codex", "pi"]);
function isAgentName(context, node) {
  return matchesLocalValue(context, node, (value) => agentNames.has(name(value, true)));
}

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
            if ((isAgentName(context, node.left) && selectsAgent(context, node.right)) ||
                (isAgentName(context, node.right) && selectsAgent(context, node.left))) report(node);
          },
          SwitchCase(node) {
            if (isAgentName(context, node.test) && selectsAgent(context, node.parent.discriminant)) report(node.test);
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
            const isRegistryMap = matchesLocalValue(context, node.callee.object, (value, binding) => {
              let owner;
              if (member(value, "sessions")) {
                owner = value.object;
              } else {
                const property = binding?.parent;
                if (property?.type !== "Property" || property.value !== binding ||
                    name(property.key, property.computed) !== "sessions" || property.parent.type !== "ObjectPattern") return false;
                const pattern = property.parent;
                const declaration = pattern.parent;
                if (hasRegistrySessions(pattern)) return true;
                if (declaration.type !== "VariableDeclarator") return false;
                if (declaration.id !== pattern) return false;
                owner = declaration.init;
              }
              return matchesLocalValue(context, owner, (candidate, ownerBinding) => {
                const ownerType = annotation(ownerBinding);
                return !ownerType && (name(candidate) === "registry" || member(candidate, "registry"));
              }, hasRegistrySessions);
            });
            if (isRegistryMap) report(node);
          },
          Property(node) {
            if (node.parent.type !== "ObjectExpression" || name(node.key, node.computed) !== "type") return;
            if (matchesLocalValue(context, node.value, (value) => name(value, true) === "session_remove")) report(node);
          },
        };
      },
    },
  },
};

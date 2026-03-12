import { findNodeAtOffset, getNodePath, parseTree, type Node } from "jsonc-parser";

export type CompletionContext =
  | {
      mode: "none";
    }
  | {
      mode: "objectKey";
      objectPath: string;
      existingKeys: Set<string>;
    }
  | {
      mode: "propertyValue";
      objectPath: string;
      propertyKey: string;
      existingKeys: Set<string>;
    };

export function resolveCompletionContext(text: string, offset: number): CompletionContext {
  const root = parseTree(text);
  if (!root) {
    return { mode: "none" };
  }

  const safeOffset = Math.max(0, Math.min(offset, text.length));
  const node =
    findNodeAtOffset(root, safeOffset, true) ??
    findNodeAtOffset(root, Math.max(0, safeOffset - 1), true);
  if (!node) {
    return { mode: "none" };
  }

  const containingObject = findContainingObjectNode(root, safeOffset);
  if (containingObject) {
    const activeProperty = findClosestPropertyNode(node);
    if (!activeProperty || findOwnerObject(activeProperty) !== containingObject) {
      return {
        mode: "objectKey",
        objectPath: normalizePath(getNodePath(containingObject)),
        existingKeys: collectExistingObjectKeys(containingObject),
      };
    }
  }

  const activeProperty = findClosestPropertyNode(node);
  if (activeProperty) {
    const valueNode = activeProperty.children?.[1];
    const propertyKey = readPropertyKey(activeProperty);

    if (valueNode && isOffsetWithinNode(safeOffset, valueNode)) {
      if (valueNode.type === "object") {
        return {
          mode: "objectKey",
          objectPath: normalizePath(getNodePath(valueNode)),
          existingKeys: collectExistingObjectKeys(valueNode),
        };
      }

      if (!propertyKey) {
        return { mode: "none" };
      }

      const objectNode = findOwnerObject(activeProperty);
      if (!objectNode) {
        return { mode: "none" };
      }

      return {
        mode: "propertyValue",
        objectPath: normalizePath(getNodePath(objectNode)),
        propertyKey,
        existingKeys: collectExistingObjectKeys(objectNode),
      };
    }

    if (!valueNode && propertyKey && isOffsetAfterPropertyKey(safeOffset, activeProperty)) {
      const objectNode = findOwnerObject(activeProperty);
      if (!objectNode) {
        return { mode: "none" };
      }

      return {
        mode: "propertyValue",
        objectPath: normalizePath(getNodePath(objectNode)),
        propertyKey,
        existingKeys: collectExistingObjectKeys(objectNode),
      };
    }
  }

  const objectNode = findClosestObjectNode(node);
  if (!objectNode) {
    return { mode: "none" };
  }

  return {
    mode: "objectKey",
    objectPath: normalizePath(getNodePath(objectNode)),
    existingKeys: collectExistingObjectKeys(objectNode),
  };
}

function findClosestObjectNode(node: Node | undefined): Node | null {
  let current = node;
  while (current) {
    if (current.type === "object") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findContainingObjectNode(root: Node, offset: number): Node | null {
  if (root.type !== "object" && root.type !== "array") {
    return findContainingObjectInChildren(root, offset);
  }
  if (!isOffsetWithinNode(offset, root)) {
    return null;
  }
  if (root.type === "object") {
    for (const child of root.children ?? []) {
      const nested = findContainingObjectNode(child, offset);
      if (nested) {
        return nested;
      }
    }
    return root;
  }
  return findContainingObjectInChildren(root, offset);
}

function findContainingObjectInChildren(node: Node, offset: number): Node | null {
  for (const child of node.children ?? []) {
    const nested = findContainingObjectNode(child, offset);
    if (nested) {
      return nested;
    }
  }
  return null;
}

function findClosestPropertyNode(node: Node | undefined): Node | null {
  let current = node;
  while (current) {
    if (current.type === "property") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function findOwnerObject(propertyNode: Node): Node | null {
  let current: Node | undefined = propertyNode.parent;
  while (current) {
    if (current.type === "object") {
      return current;
    }
    current = current.parent;
  }
  return null;
}

function readPropertyKey(propertyNode: Node): string | null {
  const keyNode = propertyNode.children?.[0];
  if (!keyNode || typeof keyNode.value !== "string") {
    return null;
  }
  return keyNode.value;
}

function collectExistingObjectKeys(node: Node): Set<string> {
  const keys = new Set<string>();
  for (const child of node.children ?? []) {
    if (child.type !== "property") {
      continue;
    }
    const keyNode = child.children?.[0];
    if (keyNode && typeof keyNode.value === "string") {
      keys.add(keyNode.value);
    }
  }
  return keys;
}

function normalizePath(path: (string | number)[]): string {
  return path
    .map((segment) => (typeof segment === "number" ? "*" : String(segment)))
    .join(".");
}

function isOffsetWithinNode(offset: number, node: Node): boolean {
  return offset >= node.offset && offset <= node.offset + node.length;
}

function isOffsetAfterPropertyKey(offset: number, propertyNode: Node): boolean {
  const keyNode = propertyNode.children?.[0];
  if (!keyNode) {
    return false;
  }

  return offset >= keyNode.offset + keyNode.length;
}

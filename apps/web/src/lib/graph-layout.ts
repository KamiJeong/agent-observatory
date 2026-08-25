import type { ObservatorySnapshot } from "@observatory/core";

export interface Point { x: number; y: number }

export const GRAPH_NODE_WIDTH = 240;
export const GRAPH_NODE_HEIGHT = 168;

interface LayoutBox {
  width: number;
  height: number;
  rootX: number;
  children: Array<{ id: string; x: number; y: number; box: LayoutBox }>;
}

export function layoutGraph(snapshot: ObservatorySnapshot): {
  positions: Record<string, Point>;
  width: number;
  height: number;
} {
  const nodeWidth = GRAPH_NODE_WIDTH;
  const nodeHeight = GRAPH_NODE_HEIGHT;
  const horizontalGap = 38;
  const verticalGap = 44;
  const positions: Record<string, Point> = {};
  const memo = new Map<string, LayoutBox>();
  const building = new Set<string>();
  const spawnChildren = new Map<string, string[]>();
  for (const edge of snapshot.edges) {
    if (edge.kind !== "spawn" || !snapshot.agents[edge.source] || !snapshot.agents[edge.target]) continue;
    const children = spawnChildren.get(edge.source) ?? [];
    if (!children.includes(edge.target)) children.push(edge.target);
    spawnChildren.set(edge.source, children);
  }
  const buildBox = (id: string): LayoutBox => {
    const cached = memo.get(id);
    if (cached) return cached;
    if (building.has(id)) return { width: nodeWidth, height: nodeHeight, rootX: 0, children: [] };
    building.add(id);
    const childIds = (spawnChildren.get(id) ?? []).filter((child) => !building.has(child));
    if (childIds.length === 0) {
      const leaf = { width: nodeWidth, height: nodeHeight, rootX: 0, children: [] };
      memo.set(id, leaf);
      building.delete(id);
      return leaf;
    }

    // Wide sibling sets become a compact matrix. A fixed depth row makes 10–50
    // agents several thousand pixels wide and forces labels below readable size.
    const columns = Math.min(6, Math.max(1, Math.ceil(Math.sqrt(childIds.length * 0.6))));
    const rows = Array.from({ length: Math.ceil(childIds.length / columns) }, (_, rowIndex) => (
      childIds.slice(rowIndex * columns, (rowIndex + 1) * columns).map((childId) => ({ id: childId, box: buildBox(childId) }))
    ));
    const rowWidths = rows.map((row) => row.reduce((sum, child) => sum + child.box.width, 0) + horizontalGap * (row.length - 1));
    const rowHeights = rows.map((row) => Math.max(...row.map((child) => child.box.height)));
    const width = Math.max(nodeWidth, ...rowWidths);
    const children: LayoutBox["children"] = [];
    let rowTop = nodeHeight + verticalGap;
    rows.forEach((row, rowIndex) => {
      let childLeft = (width - rowWidths[rowIndex]!) / 2;
      row.forEach((child) => {
        children.push({ id: child.id, x: childLeft, y: rowTop, box: child.box });
        childLeft += child.box.width + horizontalGap;
      });
      rowTop += rowHeights[rowIndex]! + verticalGap;
    });
    const box = {
      width,
      height: rowTop - verticalGap,
      rootX: (width - nodeWidth) / 2,
      children,
    };
    memo.set(id, box);
    building.delete(id);
    return box;
  };
  const place = (id: string, box: LayoutBox, left: number, top: number): void => {
    positions[id] = { x: left + box.rootX, y: top };
    for (const child of box.children) {
      place(child.id, child.box, left + child.x, top + child.y);
    }
  };
  let left = 36;
  let contentHeight = 0;
  for (const root of snapshot.roots) {
    const box = buildBox(root);
    place(root, box, left, 36);
    left += box.width + horizontalGap * 2;
    contentHeight = Math.max(contentHeight, box.height);
  }
  return { positions, width: Math.max(720, left), height: Math.max(460, contentHeight + 72) };
}

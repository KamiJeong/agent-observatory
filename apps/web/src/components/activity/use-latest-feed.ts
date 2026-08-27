import { useCallback, useLayoutEffect, useRef, useState, type UIEvent } from "react";

const LATEST_THRESHOLD = 48;

export function useLatestFeed<T extends HTMLElement>({
  itemIds,
  scopeKey,
  onJump,
}: {
  itemIds: string[];
  scopeKey: string;
  onJump?(scrollTop: number, height: number): void;
}) {
  const containerRef = useRef<T>(null);
  const previousIds = useRef<string[]>([]);
  const previousScope = useRef(scopeKey);
  const atLatestRef = useRef(true);
  const onJumpRef = useRef(onJump);
  const [atLatest, setAtLatest] = useState(true);
  const [newItemCount, setNewItemCount] = useState(0);
  onJumpRef.current = onJump;

  const jumpToLatest = useCallback(() => {
    const container = containerRef.current;
    if (!container) return;
    const scrollTop = Math.max(0, container.scrollHeight - container.clientHeight);
    container.scrollTop = scrollTop;
    atLatestRef.current = true;
    setAtLatest(true);
    setNewItemCount(0);
    onJumpRef.current?.(scrollTop, container.clientHeight);
  }, []);

  const handleScroll = useCallback((event: UIEvent<T>) => {
    const container = event.currentTarget;
    const nextAtLatest = container.scrollHeight - container.clientHeight - container.scrollTop <= LATEST_THRESHOLD;
    atLatestRef.current = nextAtLatest;
    setAtLatest(nextAtLatest);
    if (nextAtLatest) setNewItemCount(0);
  }, []);

  useLayoutEffect(() => {
    const scopeChanged = previousScope.current !== scopeKey;
    const priorIds = previousIds.current;
    const priorIdSet = new Set(priorIds);
    const addedCount = itemIds.filter((id) => !priorIdSet.has(id)).length;
    previousScope.current = scopeKey;
    previousIds.current = itemIds;

    if (scopeChanged || priorIds.length === 0 || atLatestRef.current) {
      jumpToLatest();
      return;
    }
    if (addedCount > 0) setNewItemCount((current) => current + addedCount);
  }, [itemIds, jumpToLatest, scopeKey]);

  return {
    atLatest,
    containerRef,
    handleScroll,
    jumpToLatest,
    newItemCount,
  };
}

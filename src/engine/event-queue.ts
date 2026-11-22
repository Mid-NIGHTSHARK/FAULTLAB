export interface SimEvent {
  at: number;
  run: () => void;
}

interface QueuedEvent extends SimEvent {
  order: number;
  priority: number;
  index: number;
}

function earlier(a: QueuedEvent, b: QueuedEvent): boolean {
  if (a.at !== b.at) return a.at < b.at;
  if (a.priority !== b.priority) return a.priority < b.priority;
  return a.order < b.order;
}

/** Stable min-heap with indexed removal for cancelled deadlines and arrivals. */
export class EventQueue {
  private readonly heap: QueuedEvent[] = [];
  private order = 0;

  schedule(at: number, run: () => void, priority = 0): () => void {
    const event = { at, run, order: this.order++, priority, index: this.heap.length };
    this.heap.push(event);
    this.siftUp(event);
    return () => {
      if (event.index >= 0) this.remove(event);
    };
  }

  peek(): SimEvent | undefined {
    return this.heap[0];
  }

  pop(): SimEvent {
    const first = this.heap[0];
    this.remove(first);
    return first;
  }

  private place(event: QueuedEvent, index: number): void {
    this.heap[index] = event;
    event.index = index;
  }

  private remove(event: QueuedEvent): void {
    const index = event.index;
    const tail = this.heap.pop()!;
    event.index = -1;
    if (tail === event) return;
    tail.index = index;
    const parent = (index - 1) >> 1;
    if (index > 0 && earlier(tail, this.heap[parent])) this.siftUp(tail);
    else this.siftDown(tail);
  }

  private siftUp(event: QueuedEvent): void {
    let index = event.index;
    while (index > 0) {
      const parent = (index - 1) >> 1;
      if (!earlier(event, this.heap[parent])) break;
      this.place(this.heap[parent], index);
      index = parent;
    }
    this.place(event, index);
  }

  private siftDown(event: QueuedEvent): void {
    let index = event.index;
    while (index * 2 + 1 < this.heap.length) {
      let child = index * 2 + 1;
      if (child + 1 < this.heap.length && earlier(this.heap[child + 1], this.heap[child])) child++;
      if (!earlier(this.heap[child], event)) break;
      this.place(this.heap[child], index);
      index = child;
    }
    this.place(event, index);
  }
}

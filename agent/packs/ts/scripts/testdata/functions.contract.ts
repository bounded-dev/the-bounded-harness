type Brand = string & { readonly __brand: unique symbol };

export interface Order {
  id: Brand;
  total: number;
}

export type NewOrder = Omit<Order, "id">;

export declare function createOrder(input: NewOrder): Order;

export declare function find(id: string): Order | undefined;
export declare function find(id: number): Order | undefined;

export declare function identity<T>(value: T): T;

// Not exported: not part of the component surface, must not be scaffolded.
declare function internalHelper(): void;

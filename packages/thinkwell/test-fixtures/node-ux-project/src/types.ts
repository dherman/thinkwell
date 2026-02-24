import type * as acp from "@thinkwell/acp";

/** @JSONSchema */
export interface Greeting {
  message: string;
}

/** @JSONSchema */
export interface Person {
  name: string;
  age: number;
}

export interface Done {
  type: 'done';
  result: string;
}

export interface Rename {
  type: 'rename';
  newName: string;
}

export interface GiveUp {
  type: 'giveup';
}

/** @JSONSchema */
export type Choice = Done | Rename | GiveUp;

import { pageState } from "./pageState";

function first(): void {
  localStorage.setItem("dp-first", "");
  pageState.page = "help";
}

function checkFirst(): boolean {
  return typeof localStorage.getItem("dp-first") !== "string";
}

export function checkAndDoFirst(): void {
  if (checkFirst()) first();
}

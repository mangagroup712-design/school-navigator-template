/**
 * (条件1,結果1,条件2,結果2,条件3,結果3,...)のように値を渡して条件が合ったタイミングで結果を返す。\
 * いずれの条件も合わなければundefinedが帰ってくる。
 */
export function multiSelect(...args: any[]): any {
  let condition: boolean | undefined = undefined;
  for (const arg of args) {
    if (typeof condition === "undefined") {
      condition = !!arg;
      continue;
    }
    if (condition) return arg;
    else condition = undefined;
  }
}

/**
 * 指定したミリ秒後に解決するPromise。
 */
export function timeout(ms: number): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((rs, rj) => setTimeout(() => rs(), ms));
}

/**
 * 2桁最初0埋めで、hour:minuteとなる文字列を生成する。
 */
export function hourMinute(hour: number | string, minute: number | string): string {
  return `${hour.toString().padStart(2, "0")}:${minute.toString().padStart(2, "0")}`;
}

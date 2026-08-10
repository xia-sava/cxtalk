import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  renameSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, delimiter } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(ROOT, "src", "cxtalk.ts");
const BIN_DIR = join(ROOT, "bin");
const HOOK = join(ROOT, "hooks", "stop.sh");

type Message = {
  seq: number;
  from: string;
  at: string;
  advanced: boolean | null;
  text: string;
};

/** SPEC が定める next の全体。示せる行動が増えたらここだけが増える。 */
const NEXT_VALUES = ["say", "receive", "report", "ask_user", "retry"] as const;

/** SPEC が定める閉じ方。実装とは別に書き、片方だけ増えたときに落ちるようにする。 */
const CLOSED_REASONS = ["hop_limit", "stale", "no_response", "idle", "manual"] as const;

/** SPEC が定める待機の予算。同じく実装とは別に書く。 */
const RETRY_LIMIT = 9;

type Reply = {
  ok: boolean;
  next?: (typeof NEXT_VALUES)[number];
  hint?: string;
  error?: string;
  room_id?: string;
  as?: string;
  topic?: string;
  status?: string;
  turn?: string;
  seq?: number;
  hops_left?: number;
  hops_used?: number;
  max_hops?: number;
  rejoined?: boolean;
  messages?: Message[];
  closed_reason?: string | null;
  kept?: string | null;
  retries_left?: number | null;
  waited_seconds?: number;
  silent_seconds?: number;
  unread?: Record<string, number>;
  ignored?: string[];
  unknown_keys?: string[];
  participants?: string[];
  last_activity_at?: string;
  hook_last_run?: string | null;
  log_path?: string;
  rooms?: {
    room_id: string;
    log_path: string;
    status: string;
    closed_reason: string | null;
    max_hops: number;
    hops_used: number;
  }[];
  unreadable?: string[];
};

type ParticipantState = { last_read: number; timeouts: number; join_timeouts: number };

/** 人間が手で書き換える room.json。欠けた値や書き間違いを作れる形で持つ。 */
type EditableRoom = {
  id?: string;
  max_hops?: number | string;
  opener?: string;
  status?: string;
  closed_reason?: string | null;
  last_activity_at?: string;
  participants: Record<string, Partial<Record<keyof ParticipantState, number | string>>>;
};

type Run = { out: string; err: string; code: number };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cxtalk-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * 名乗りごとに別のセッションとして扱う。控えはセッションを鍵にするため、
 * 1 つの id を共有すると 2 つのセッションを区別できなくなる。
 */
const sessionFor = (as: string): string => `s-${as}`;

const sessionOf = (args: string[]): string => {
  const at = args.indexOf("--as");
  const as = at < 0 ? undefined : args[at + 1];
  return as === undefined ? "s-none" : sessionFor(as);
};

const run = (...args: string[]): Run => {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", CLI, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, CXTALK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionOf(args) },
    },
  );
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
};

const j = (...args: string[]): Reply => JSON.parse(run(...args).out);

/** bash が無ければ入口も hook も成立しない。値の食い違いとして報告されないようにする。 */
const viaBash = (args: string[], options: Record<string, unknown>): Run => {
  const r = spawnSync("bash", args, { encoding: "utf8", ...options });
  if (r.error) throw new Error(`bash を起動できません: ${r.error.message}`);
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
};

/** 利用者が叩く入口。src を直接起動する run() では通らない。 */
const bin = (...args: string[]): Run =>
  viaBash([join(BIN_DIR, "cxtalk"), ...args], {
    env: { ...process.env, CXTALK_HOME: home },
  });

/**
 * repo を作業ディレクトリにして、シェル自身にパスを綴らせる。
 * $PWD はそのシェルの名前空間の形になるため、環境ごとの表記を test が持たずに済む。
 */
const inRepo = (script: string, env: Record<string, string> = {}): Run =>
  viaBash(["-c", script], {
    cwd: ROOT,
    env: { ...process.env, CXTALK_HOME: home, ...env },
  });

/**
 * Stop hook を、Claude Code がするのと同じく標準入力の JSON で起動する。
 * 名乗りは作業ディレクトリから決まるため、参加者名のディレクトリを cwd に渡す。
 */
const stopHook = (input: string, as: string): Run => {
  const cwd = join(home, as);
  mkdirSync(cwd, { recursive: true });
  return viaBash([HOOK], {
    input,
    cwd,
    env: {
      ...process.env,
      CXTALK_HOME: home,
      CLAUDE_CODE_SESSION_ID: sessionFor(as),
      PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
};

const TOPIC = "確認テストの合格基準は正答数か正答率か";

/** alpha がルームを開き、beta が参加した状態を作る。 */
const opened = (maxHops = 5): string => {
  const room = j("open", "--topic", TOPIC, "--max-hops", String(maxHops), "--as", "alpha");
  j("join", room.room_id!, "--as", "beta");
  return room.room_id!;
};

const say = (room: string, as: string, text: string, advanced: boolean): Reply =>
  j("say", room, "--text", text, "--advanced", String(advanced), "--as", as);

/** 待機の予算を使い切るまで呼び直す。上限に達したときの応答を返す。 */
const exhaustWaits = (room: string, as: string): Reply => {
  let last: Reply = {} as Reply;
  for (let i = 0; i <= RETRY_LIMIT; i++) {
    last = j("receive", room, "--timeout", "1", "--as", as);
    if (last.next !== "receive") break;
  }
  return last;
};

const roomStatePath = (room: string): string => join(home, "rooms", room, "room.json");

const messagePath = (room: string, file: string): string =>
  join(home, "rooms", room, "messages", file);

const roomState = (
  room: string,
): { status: string; closed_reason: string | null; last_activity_at: string } =>
  JSON.parse(readFileSync(roomStatePath(room), "utf8"));

const participantsOf = (room: string): Record<string, ParticipantState> =>
  JSON.parse(readFileSync(roomStatePath(room), "utf8")).participants;

const participantState = (room: string, name: string): ParticipantState =>
  participantsOf(room)[name];

/** 発言を書いてから状態を書くまでの間で落ちた状態を作る。 */
const dropLastRead = (room: string, name: string): void => {
  const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
  state.participants[name].last_read = 0;
  writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
};

/** 最終更新を指定した分だけ過去にする。掃除の境界を跨がせるために分で指定する。 */
const idleFor = (room: string, minutes: number): void => {
  const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
  state.last_activity_at = new Date(Date.now() - minutes * 60 * 1000).toISOString();
  writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
};

/** 最終更新を十分に古くして、掃除の対象にする。 */
const makeStale = (room: string): void => idleFor(room, 60);

describe("open", () => {
  test("room_id と自分の名前を返す", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.ok, true);
    assert.match(r.room_id!, /^r-/);
    assert.equal(r.as, "alpha");
    assert.equal(r.topic, TOPIC);
  });

  test("相手が room_id を知らないため next は ask_user", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.next, "ask_user");
  });

  test("開いた側に発言権がある", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.turn, "alpha");
  });

  test("max_hops の既定値は 5", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.max_hops, 5);
  });

  test("--max-hops で上限を変えられる", () => {
    const r = j("open", "--topic", TOPIC, "--max-hops", "3", "--as", "alpha");
    assert.equal(r.max_hops, 3);
  });

  test("--as を省略すると cwd の repo 名を名乗る", () => {
    const r = j("open", "--topic", TOPIC);
    assert.equal(r.as, "cxtalk");
  });

  test("room_id はルームごとに異なる", () => {
    const a = j("open", "--topic", TOPIC, "--as", "alpha");
    const b = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.notEqual(a.room_id, b.room_id);
  });

  test("hint は名乗りが衝突する条件を自分の名前で示す", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.match(r.hint!, /"alpha" だと名乗りが衝突/);
  });

  test("hint は衝突したときの対処として --as を挙げる", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.match(r.hint!, /--as で別の名前/);
  });
});

describe("join", () => {
  test("新規参加は相手を待つ", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    const r = j("join", room, "--as", "beta");
    assert.equal(r.ok, true);
    assert.equal(r.status, "open");
    assert.equal(r.next, "receive");
  });

  test("新規参加では rejoined が立たない", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    const r = j("join", room, "--as", "beta");
    assert.notEqual(r.rejoined, true);
  });

  test("再入場で自分の番なら say", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("join", room, "--as", "beta");
    assert.equal(r.rejoined, true);
    assert.equal(r.next, "say");
  });

  test("再入場で相手の番なら receive", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("join", room, "--as", "alpha");
    assert.equal(r.rejoined, true);
    assert.equal(r.next, "receive");
  });

  test("同名の参加者は再入場として扱う", () => {
    const room = opened();
    const r = j("join", room, "--as", "beta");
    assert.equal(r.rejoined, true);
  });

  test("再入場では last_read 以降の差分だけを返す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    j("join", room, "--as", "beta");
    say(room, "beta", "ふたつめ", true);
    say(room, "alpha", "みっつめ", true);
    const r = j("join", room, "--as", "beta");
    assert.deepEqual(
      r.messages!.map((m) => m.text),
      ["みっつめ"],
    );
  });

  test("閉じたルームにも入れて履歴を返す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    j("close", room, "--as", "alpha");
    const r = j("join", room, "--as", "beta");
    assert.equal(r.ok, true);
    assert.equal(r.status, "closed");
    assert.equal(r.next, "report");
    assert.equal(r.messages!.length, 1);
  });

  test("存在しない room_id は ok: false", () => {
    const r = j("join", "r-0000", "--as", "beta");
    assert.equal(r.ok, false);
    assert.equal(r.next, "ask_user");
  });

  test("日本語の本文がそのまま往復する", () => {
    const room = opened();
    say(room, "alpha", "全角の「引用符」と改行\nを含む本文", true);
    const r = j("join", room, "--as", "beta");
    assert.equal(r.messages![0].text, "全角の「引用符」と改行\nを含む本文");
  });
});

describe("say", () => {
  test("通常の発言は相手待ちになる", () => {
    const room = opened();
    const r = say(room, "alpha", "最初の論点です", true);
    assert.equal(r.ok, true);
    assert.equal(r.next, "receive");
    assert.equal(r.turn, "beta");
  });

  test("seq は 1 から始まり発言ごとに増える", () => {
    const room = opened();
    assert.equal(say(room, "alpha", "ひとつめ", true).seq, 1);
    assert.equal(say(room, "beta", "ふたつめ", true).seq, 2);
    assert.equal(say(room, "alpha", "みっつめ", true).seq, 3);
  });

  test("自分の番でなければ ok: false と not_your_turn", () => {
    const room = opened();
    const r = say(room, "beta", "割り込みます", true);
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_your_turn");
    assert.equal(r.next, "receive");
    assert.equal(r.turn, "alpha");
  });

  test("閉じたルームには発言できない", () => {
    const room = opened();
    j("close", room, "--as", "alpha");
    const r = say(room, "alpha", "まだ話したい", true);
    assert.equal(r.ok, false);
    assert.equal(r.next, "report");
  });

  test("--advanced は必須", () => {
    const room = opened();
    const r = j("say", room, "--text", "上げ忘れ", "--as", "alpha");
    assert.equal(r.ok, false);
  });
});

describe("hops は往復で数える", () => {
  test("最初の発言で 1 往復目に入る", () => {
    const room = opened(5);
    assert.equal(say(room, "alpha", "ひとつめ", true).hops_left, 4);
  });

  test("両者が発言して 1 往復", () => {
    const room = opened(5);
    say(room, "alpha", "ひとつめ", true);
    assert.equal(say(room, "beta", "ふたつめ", true).hops_left, 4);
    assert.equal(say(room, "alpha", "みっつめ", true).hops_left, 3);
  });

  test("上限に達したら close して要約を促す", () => {
    const room = opened(1);
    say(room, "alpha", "ひとつめ", true);
    const r = say(room, "beta", "ふたつめ", true);
    assert.equal(r.ok, true);
    assert.equal(r.status, "closed");
    assert.equal(r.closed_reason, "hop_limit");
    assert.equal(r.next, "report");
    assert.equal(r.hops_left, 0);
  });
});

describe("stale_streak", () => {
  test("advanced: false が 2 連続で close", () => {
    const room = opened();
    say(room, "alpha", "同意します", false);
    const r = say(room, "beta", "ありがとうございます", false);
    assert.equal(r.status, "closed");
    assert.equal(r.closed_reason, "stale");
    assert.equal(r.next, "report");
  });

  // 連長からはどの発言かを戻せない。名指ししないと、言われた側は自分の発言を疑うしかない。
  test("閉じた hint がどの 2 件かを名指しする", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    say(room, "beta", "同意します", false);
    const r = say(room, "alpha", "ありがとうございます", false);
    assert.equal(r.closed_reason, "stale");
    assert.match(r.hint!, /2 件目と 3 件目/);
  });

  test("advanced: true を挟めば連続が切れる", () => {
    const room = opened();
    say(room, "alpha", "同意します", false);
    say(room, "beta", "ここが論点です", true);
    const r = say(room, "alpha", "了解しました", false);
    assert.equal(r.status, undefined);
    assert.equal(r.next, "receive");
  });
});

describe("receive", () => {
  test("自分の番なら待たずに返す", () => {
    const room = opened();
    const r = j("receive", room, "--as", "alpha");
    assert.equal(r.ok, true);
    assert.equal(r.status, "your_turn");
    assert.equal(r.next, "say");
  });

  test("新着があれば返して発言を促す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("receive", room, "--as", "beta");
    assert.equal(r.status, "message");
    assert.equal(r.next, "say");
    assert.deepEqual(
      r.messages!.map((m) => m.text),
      ["最初の論点です"],
    );
  });

  test("複数ルームを待てるよう room_id を必ず返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("receive", room, "--as", "beta");
    assert.equal(r.room_id, room);
  });

  test("時間切れならリトライの残りを添えて返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.equal(r.next, "receive");
    assert.equal(r.waited_seconds, 1);
    assert.equal(r.retries_left, RETRY_LIMIT - 1);
  });

  // 既定値は時間切れの出力にしか現れないため、確かめるには実際に待つしかない。
  // 呼び出し側の Bash 実行の既定（120 秒）を超えると、外から打ち切られて
  // 原因の分からない失敗になる。この 1 件だけがその関係を固定している。
  test("既定の待機は呼び出し側の制限の内側に収まる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("receive", room, "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.ok(r.waited_seconds! < 120, `既定の待機が ${r.waited_seconds} 秒になっている`);
  });

  // 相手が停止したのか書いている最中なのかはディスクに現れない。閉じると相手の say は
  // 入口で断られ、書かれないまま失われるため、判定せずに人間へ返す。
  test("会話中に待機を使い切っても閉じずに人間へ返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const last = exhaustWaits(room, "alpha");
    assert.equal(last.status, "no_answer");
    assert.equal(last.next, "ask_user");
    assert.equal(roomState(room).status, "open");
  });

  // 相手が動いていても未読を知らされていないことがある。応答が無い理由の候補になる。
  test("記録が無ければ起こす仕組みを候補に挙げる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const last = exhaustWaits(room, "alpha");
    assert.equal(last.hook_last_run, null);
    assert.match(last.hint!, /知らされていない可能性/);
  });

  test("記録があれば候補に挙げない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    writeFileSync(join(home, "last_check"), "2026-08-10T14:00:00+09:00\n", "utf8");
    const last = exhaustWaits(room, "alpha");
    assert.equal(last.hook_last_run, "2026-08-10T14:00:00+09:00");
    assert.doesNotMatch(last.hint!, /知らされていない可能性/);
  });

  // 待ち切ったときの案内は、実装が実際にすることと揃っている必要がある。
  test("待ち続けても閉じることを伝える", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.match(exhaustWaits(room, "alpha").hint!, /待ち続けていても/);
  });

  test("使い切った後も予算は配り直される", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    exhaustWaits(room, "alpha");
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.equal(r.retries_left, RETRY_LIMIT - 1);
  });

  // 閉じていれば say は入口で断られる。使い切った後に届いた発言が残ることを固定する。
  test("使い切った後に相手が発言できる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    exhaustWaits(room, "alpha");
    assert.equal(say(room, "beta", "遅れて届く見解です", true).ok, true);
    assert.equal(j("receive", room, "--timeout", "1", "--as", "alpha").messages!.length, 1);
  });

  test("参加を待ち切ったら no_response で close", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    const last = exhaustWaits(room, "alpha");
    assert.equal(last.status, "closed");
    assert.equal(last.closed_reason, "no_response");
    assert.equal(last.next, "report");
  });

  test("相手が閉じていれば報告を促す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "beta");
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "closed");
    assert.equal(r.next, "report");
  });
});

describe("status", () => {
  // 呼び出した本人の名前で確かめる。参加していない名前では、
  // 既読にする不具合が入っても last_read が無いため常に通ってしまう。
  test("既読にせず last_read を更新しない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("status", room, "--as", "beta");
    assert.equal(participantState(room, "beta").last_read, 0);
    const r = j("join", room, "--as", "beta");
    assert.equal(r.messages!.length, 1);
  });

  test("未読数を参加者ごとに返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = j("status", room);
    assert.equal(r.unread!.beta, 1);
    assert.equal(r.unread!.alpha, 0);
  });

  test("参加者と発言権を返す", () => {
    const room = opened();
    const r = j("status", room);
    assert.deepEqual([...r.participants!].sort(), ["alpha", "beta"]);
    assert.equal(r.turn, "alpha");
    assert.equal(r.topic, TOPIC);
  });

  // 残りを知る手段が時間切れの応答だけだと、知るために 1 回使うことになる。
  test("待機の残りを副作用なしで返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.equal(j("status", room, "--as", "alpha").retries_left, RETRY_LIMIT);
    j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(j("status", room, "--as", "alpha").retries_left, RETRY_LIMIT - 1);
  });

  // 予算を持たない名前に 0 を返すと、使い切ったのと区別が付かない。
  test("参加していない名前には待機の残りを返さない", () => {
    assert.equal(j("status", opened(), "--as", "carol").retries_left, null);
  });

  test("閉じた理由と往復の上限を返す", () => {
    const room = opened(3);
    j("close", room, "--as", "alpha");
    const r = j("status", room, "--as", "alpha");
    assert.equal(r.closed_reason, "manual");
    assert.equal(r.max_hops, 3);
  });
});

describe("close", () => {
  test("理由と使った往復数を返す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    say(room, "beta", "ふたつめ", true);
    const r = j("close", room, "--as", "alpha");
    assert.equal(r.ok, true);
    assert.equal(r.closed_reason, "manual");
    assert.equal(r.hops_used, 1);
    assert.equal(r.next, "report");
  });

  // 閉じることは活動ではない。打ち直すと、無音がいつ始まったかを戻せなくなる。
  test("閉じても最終活動の時刻を書き換えない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    idleFor(room, 40);
    const before = roomState(room).last_activity_at;
    j("close", room, "--as", "alpha");
    assert.equal(roomState(room).last_activity_at, before);
  });

  test("掃除で閉じても最終活動の時刻を書き換えない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    makeStale(room);
    const before = roomState(room).last_activity_at;
    j("status", room, "--as", "alpha");
    assert.equal(roomState(room).closed_reason, "idle");
    assert.equal(roomState(room).last_activity_at, before);
  });
});

describe("ls", () => {
  test("開いているルームを列挙する", () => {
    const a = opened();
    const b = opened();
    const out = run("ls").out;
    assert.match(out, new RegExp(a));
    assert.match(out, new RegExp(b));
  });

  // 選ぶのは人間。閉じた理由と進み具合が出ないと、話し切ったルームと
  // 何も起きなかったルームが同じ closed にしか見えない。
  test("閉じた理由と進み具合を出す", () => {
    const talked = opened(3);
    say(talked, "alpha", "ひとつめ", true);
    say(talked, "beta", "ふたつめ", true);
    j("close", talked, "--as", "alpha");
    const silent = opened(3);
    j("close", silent, "--as", "alpha");

    const rooms = j("ls").rooms ?? [];
    const listed = (id: string) => rooms.find((room) => room.room_id === id)!;
    assert.equal(listed(talked).hops_used, 1);
    assert.equal(listed(silent).hops_used, 0);
    assert.equal(listed(talked).closed_reason, "manual");
    assert.equal(listed(talked).max_hops, 3);
  });
});

describe("check", () => {
  test("自分の番で未読があれば exit 0 と 1 行", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = run("check", "--as", "beta");
    assert.equal(r.code, 0);
    assert.match(r.out.trim(), new RegExp(`^${room}:`));
    assert.equal(r.out.trim().split("\n").length, 1);
  });

  test("残り往復数と話題を含む", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const r = run("check", "--as", "beta");
    assert.match(r.out, /残り/);
    assert.match(r.out, new RegExp(TOPIC));
  });

  test("相手の番なら exit 1", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.equal(run("check", "--as", "alpha").code, 1);
  });

  test("未読がなければ exit 1", () => {
    opened();
    assert.equal(run("check", "--as", "alpha").code, 1);
  });

  test("閉じていても未読があれば知らせる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    assert.equal(run("check", "--as", "beta").code, 0);
  });

  test("閉じたルームでも未読がなければ exit 1", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("receive", room, "--as", "beta");
    j("close", room, "--as", "alpha");
    assert.equal(run("check", "--as", "beta").code, 1);
  });

  test("読めば次からは知らせない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    assert.equal(run("check", "--as", "beta").code, 0);
    j("receive", room, "--as", "beta");
    assert.equal(run("check", "--as", "beta").code, 1);
  });

  // 壊れた 1 件で全件が失われると、未読があること自体が伝わらなくなる。
  test("壊れたルームがあっても他のルームの未読は知らせる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    mkdirSync(join(home, "rooms", "r-broken"), { recursive: true });
    writeFileSync(join(home, "rooms", "r-broken", "room.json"), "{ 壊れた", "utf8");
    const r = run("check", "--as", "beta");
    assert.equal(r.code, 0);
    assert.match(r.out.trim(), new RegExp(`^${room}:`));
  });

  test("壊れたルームだけなら知らせることはない", () => {
    mkdirSync(join(home, "rooms", "r-broken"), { recursive: true });
    writeFileSync(join(home, "rooms", "r-broken", "room.json"), "{ 壊れた", "utf8");
    assert.equal(run("check", "--as", "alpha").code, 1);
  });

  test("JSON ではなく素のテキストを返す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    const out = run("check", "--as", "beta").out.trim();
    assert.throws(() => JSON.parse(out));
  });

  test("警告を標準エラーに出さない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.equal(run("check", "--as", "beta").err, "");
  });
});

describe("共通規約", () => {
  test("check 以外は ok と next を必ず返す", () => {
    const room = opened();
    for (const r of [
      j("open", "--topic", TOPIC, "--as", "alpha"),
      j("join", room, "--as", "beta"),
      say(room, "alpha", "ひとつめ", true),
      j("receive", room, "--as", "beta"),
      j("close", room, "--as", "alpha"),
      j("open", "--topic", TOPIC, "--max-hops", "0", "--as", "alpha"),
      j("join", "--as", "beta"),
      j("say", room, "--text", "ふたつめ", "--advanced", "--as", "alpha"),
    ]) {
      assert.equal(typeof r.ok, "boolean");
      assert.ok(NEXT_VALUES.includes(r.next!));
    }
  });

  test("異常でも終了コードを 0 に保ち JSON で返す", () => {
    const r = run("join", "r-0000", "--as", "beta");
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).ok, false);
  });

  test("hint は行動を促す文字列", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(typeof r.hint, "string");
    assert.ok(r.hint!.length > 0);
  });
});

describe("生ログへの導線", () => {
  test("報告に移る出力は原文の場所を返す", () => {
    const room = opened();
    const r = j("close", room, "--as", "alpha");
    assert.ok(r.log_path!.includes(room));
  });

  test("hint にも場所を含める", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const r = j("close", room, "--as", "alpha");
    assert.ok(r.hint!.includes(r.log_path!));
  });

  // 要約を求めない相手に原文を読ませる理由が無い。場所は log_path で返している。
  test("発言が無ければ hint は場所を促さない", () => {
    const r = j("close", opened(), "--as", "alpha");
    assert.ok(!r.hint!.includes(r.log_path!));
    assert.ok(r.log_path!.length > 0);
  });

  test("上限で閉じた say も場所を返す", () => {
    const room = opened(1);
    say(room, "alpha", "ひとつめ", true);
    const r = say(room, "beta", "ふたつめ", true);
    assert.ok(r.log_path!.includes(room));
  });

  test("status は場所を返す", () => {
    const room = opened();
    assert.ok(j("status", room).log_path!.includes(room));
  });

  test("ls は各ルームの場所を返す", () => {
    const room = opened();
    const rooms = j("ls").rooms!;
    assert.ok(rooms.some((r) => r.room_id === room && r.log_path.includes(room)));
  });

  test("閉じたルームへの join も場所を返す", () => {
    const room = opened();
    j("close", room, "--as", "alpha");
    assert.ok(j("join", room, "--as", "beta").log_path!.includes(room));
  });
});

describe("閉じたルームの未読", () => {
  /** 上限に達すると最後の発言は相手にとって未読のまま残る。 */
  const exhausted = (): string => {
    const room = opened(1);
    say(room, "alpha", "ひとつめ", true);
    say(room, "beta", "ふたつめ", true);
    return room;
  };

  test("receive は閉じていても未読を渡す", () => {
    const room = exhausted();
    const r = j("receive", room, "--as", "alpha");
    assert.equal(r.status, "closed");
    assert.equal(r.next, "report");
    assert.deepEqual(
      r.messages!.map((m) => m.text),
      ["ふたつめ"],
    );
  });

  test("渡した未読は既読になる", () => {
    const room = exhausted();
    j("receive", room, "--as", "alpha");
    assert.equal(j("status", room).unread!.alpha, 0);
  });

  test("未読がなければ messages は空", () => {
    const room = exhausted();
    assert.deepEqual(j("receive", room, "--as", "beta").messages, []);
  });
});

describe("落ちた自分の発言を未読として扱わない", () => {
  /** 自分の発言と相手の発言の両方が未読として残った状態を作る。 */
  const mixed = (): string => {
    const room = opened(3);
    say(room, "alpha", "ひとつめ", true);
    say(room, "beta", "ふたつめ", true);
    dropLastRead(room, "alpha");
    return room;
  };

  /** 未読が自分の発言だけの状態を作る。 */
  const onlyOwn = (): string => {
    const room = opened(3);
    say(room, "alpha", "ひとつめ", true);
    j("close", room, "--as", "alpha");
    dropLastRead(room, "alpha");
    return room;
  };

  test("閉じたルームの receive は相手の発言だけを返す", () => {
    const room = mixed();
    j("close", room, "--as", "beta");
    assert.deepEqual(
      j("receive", room, "--as", "alpha").messages!.map((m) => m.text),
      ["ふたつめ"],
    );
  });

  test("自分の発言しかなければ messages は空", () => {
    assert.deepEqual(j("receive", onlyOwn(), "--as", "alpha").messages, []);
  });

  test("返すものが無くても既読の位置は進む", () => {
    const room = onlyOwn();
    j("receive", room, "--as", "alpha");
    assert.equal(participantState(room, "alpha").last_read, 1);
  });

  test("status の未読件数は自分の発言を含めない", () => {
    assert.equal(j("status", mixed()).unread!.alpha, 1);
  });

  test("check の件数も自分の発言を含めない", () => {
    assert.match(run("check", "--as", "alpha", "--room", mixed()).out, /beta から 1 件/);
  });
});

describe("終端の伝え方", () => {
  test("上限で閉じた発言には相手が応答できないと伝える", () => {
    const room = opened(1);
    say(room, "alpha", "ひとつめ", true);
    const r = say(room, "beta", "ふたつめ", true);
    assert.match(r.hint!, /応答できません/);
  });

  test("stale で閉じた場合はその文言を出さない", () => {
    const room = opened();
    say(room, "alpha", "同意します", false);
    const r = say(room, "beta", "ありがとうございます", false);
    assert.equal(r.closed_reason, "stale");
    assert.doesNotMatch(r.hint!, /応答できません/);
  });

  test("待ち切っても停止か長考かを断定しない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const last = exhaustWaits(room, "alpha");
    assert.equal(last.status, "no_answer");
    assert.match(last.hint!, /分かりません/);
  });

  // 相手が動いているかはディスクに無い。確かめられる人へ、確かめ方とともに渡す。
  test("待ち切ったら相手のセッションを確かめるよう促す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const hint = exhaustWaits(room, "alpha").hint!;
    assert.match(hint, /receive/);
    assert.match(hint, /close/);
    assert.match(hint, /idle/);
  });

  test("時間切れを異常として伝えない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.match(r.hint!, /異常ではなく/);
  });
});

describe("名乗り", () => {
  test("--as を省略した join は同名の参加者として再入場になる", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    assert.equal(j("join", room).rejoined, true);
  });

  test("同名で入ると参加者は 1 人のまま", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    j("join", room);
    assert.deepEqual(j("status", room).participants, ["cxtalk"]);
  });

  test("--as で名乗り分ければ別人として並ぶ", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    j("join", room, "--as", "bob");
    assert.deepEqual([...j("status", room).participants!].sort(), ["alice", "bob"]);
  });

  test("参加者が自分だけなら発言できない", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    j("join", room);
    const r = j("say", room, "--text", "ひとりごと", "--advanced", "true");
    assert.equal(r.ok, false);
    assert.equal(r.error, "alone_in_room");
  });

  // 相手を待てば解決する。人間を呼ぶと、席を外している間は会話が止まる。
  test("相手を待つよう促す", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    j("join", room);
    const r = j("say", room, "--text", "ひとりごと", "--advanced", "true");
    assert.equal(r.next, "receive");
    assert.match(r.hint!, /receive/);
  });

  test("待っても来ない場合の手掛かりを添える", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    j("join", room);
    const r = j("say", room, "--text", "ひとりごと", "--advanced", "true");
    assert.match(r.hint!, /--as/);
  });

  test("相手が来るまでは開いた本人も発言できない", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    assert.equal(say(room, "alice", "第一声", true).error, "alone_in_room");
  });

  test("相手が来れば発言できる", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    j("join", room, "--as", "bob");
    assert.equal(say(room, "alice", "第一声", true).ok, true);
  });
});

describe("引数の解釈", () => {
  test("本文が -- で始まっても失われない", () => {
    const room = opened();
    const text = "--- 水平線ではじまる本文";
    say(room, "alpha", text, true);
    assert.equal(j("join", room, "--as", "beta").messages![0].text, text);
  });

  test("箇条書きと区切り線を含む本文をそのまま保つ", () => {
    const room = opened();
    const text = "- ひとつめ\n- ふたつめ\n\n--- 区切り";
    say(room, "alpha", text, true);
    assert.equal(j("join", room, "--as", "beta").messages![0].text, text);
  });

  test("--advanced に解釈できない値を渡すと理由が分かる", () => {
    const room = opened();
    const r = j("say", room, "--text", "本文", "--advanced", "yes", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
    assert.match(r.hint!, /yes/);
  });

  test("--text の欠落と --advanced の欠落を区別する", () => {
    const room = opened();
    assert.match(j("say", room, "--advanced", "true", "--as", "alpha").hint!, /--text/);
    assert.match(j("say", room, "--text", "本文", "--as", "alpha").hint!, /--advanced/);
  });
});

describe("数値フラグ", () => {
  test("--max-hops が数値でなければ断る", () => {
    const r = j("open", "--topic", TOPIC, "--max-hops", "abc", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
  });

  test("--max-hops が 0 以下なら断る", () => {
    assert.equal(j("open", "--topic", TOPIC, "--max-hops", "0", "--as", "alpha").ok, false);
    assert.equal(j("open", "--topic", TOPIC, "--max-hops", "-1", "--as", "alpha").ok, false);
  });

  test("小数は受けない", () => {
    assert.equal(j("open", "--topic", TOPIC, "--max-hops", "2.5", "--as", "alpha").ok, false);
  });

  test("--timeout が数値でなければ待たずに断る", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const r = j("receive", room, "--timeout", "abc", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
  });
});

describe("複数ルームの待機", () => {
  test("room_id を 2 つ渡すと断る", () => {
    const r = j("receive", opened(), opened(), "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.error, "multiple_rooms");
    assert.equal(r.next, "retry");
  });

  test("1 つなら通常どおり動く", () => {
    assert.equal(j("receive", opened(), "--as", "alpha").status, "your_turn");
  });
});

describe("参加者は 2 人まで", () => {
  test("3 人目の join を断る", () => {
    const room = opened();
    const r = j("join", room, "--as", "gamma");
    assert.equal(r.ok, false);
    assert.equal(r.error, "room_full");
    assert.deepEqual([...r.participants!].sort(), ["alpha", "beta"]);
  });

  test("断られた者は参加者に加わらない", () => {
    const room = opened();
    j("join", room, "--as", "gamma");
    assert.deepEqual([...j("status", room).participants!].sort(), ["alpha", "beta"]);
  });

  test("再入場は人数に数えない", () => {
    const room = opened();
    assert.equal(j("join", room, "--as", "alpha").ok, true);
    assert.equal(j("join", room, "--as", "beta").ok, true);
  });
});

describe("読み書きは参加者に限る", () => {
  test("参加していない名前では receive できない", () => {
    const room = opened();
    say(room, "alpha", "秘密の話", true);
    const r = j("receive", room, "--as", "stranger");
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_a_participant");
  });

  test("参加していない名前では say できない", () => {
    const room = opened();
    const r = j("say", room, "--text", "割り込み", "--advanced", "true", "--as", "stranger");
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_a_participant");
  });

  test("参加していない名前では close できない", () => {
    const room = opened();
    const r = j("close", room, "--as", "stranger");
    assert.equal(r.ok, false);
    assert.equal(r.error, "not_a_participant");
    assert.equal(j("status", room).status, "open");
  });

  test("status と ls は誰でも読める", () => {
    const room = opened();
    assert.equal(j("status", room, "--as", "stranger").ok, true);
    assert.equal(j("ls").ok, true);
  });

  test("status は参加していない名前に会話の指示を出さない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const r = j("status", room, "--as", "stranger");
    assert.equal(r.next, "ask_user");
    assert.match(r.hint!, /参加していません/);
  });

  test("閉じたルームでも参加していない名前には要約を求めない", () => {
    const room = opened(1);
    say(room, "alpha", "ひとつめ", true);
    say(room, "beta", "ふたつめ", true);
    const r = j("status", room, "--as", "stranger");
    assert.equal(r.status, "closed");
    assert.equal(r.next, "ask_user");
    assert.doesNotMatch(r.hint!, /要約/);
  });
});

describe("参加者名の検証", () => {
  test("数字だけの名前を断る", () => {
    const r = j("open", "--topic", TOPIC, "--as", "123");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
    assert.equal(r.next, "retry");
  });

  test("パス区切りを含む名前を断る", () => {
    for (const name of ["a/b", "a\\b", "..", "a:b"]) {
      assert.equal(j("open", "--topic", TOPIC, "--as", name).ok, false, name);
    }
  });

  test("断られたときルームは作られない", () => {
    j("open", "--topic", TOPIC, "--as", "123");
    assert.deepEqual(j("ls").rooms, []);
  });

  test("普通の名前は通る", () => {
    assert.equal(j("open", "--topic", TOPIC, "--as", "backend").ok, true);
  });

  test("status も使えない名前を断る", () => {
    const room = opened();
    const r = j("status", room, "--as", "../escape");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
  });
});

describe("値の無いフラグ", () => {
  test("末尾の --advanced を誤りとして断る", () => {
    const room = opened();
    const r = j("say", room, "--text", "本文", "--as", "alpha", "--advanced");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
    assert.equal(r.next, "retry");
  });

  test("末尾の --text で本文が true にならない", () => {
    const room = opened();
    j("say", room, "--advanced", "true", "--as", "alpha", "--text");
    assert.equal(j("status", room).unread!.beta, 0);
  });

  test("check では終了コード 2 に倒す", () => {
    assert.equal(run("check", "--as").code, 2);
  });
});

describe("発言権を seq から導く", () => {
  test("room.json は turn と hops を持たない", () => {
    const room = opened();
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    assert.equal("turn" in state, false);
    assert.equal("hops" in state, false);
    assert.equal(state.opener, "alpha");
  });

  test("発言のたびに発言権が入れ替わる", () => {
    const room = opened();
    assert.equal(j("status", room).turn, "alpha");
    say(room, "alpha", "ひとつめ", true);
    assert.equal(j("status", room).turn, "beta");
    say(room, "beta", "ふたつめ", true);
    assert.equal(j("status", room).turn, "alpha");
  });

  test("メッセージだけ書かれても発言権は崩れない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    // room.json を発言前の状態に戻しても、発言権はファイル名から導かれる
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    state.stale_streak = 0;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    assert.equal(j("status", room).turn, "beta");
    assert.equal(say(room, "beta", "ふたつめ", true).ok, true);
  });
});

describe("参加を待つ", () => {
  test("相手が居ない間 receive は待つ", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    const r = j("receive", room, "--timeout", "1", "--as", "alice");
    assert.equal(r.status, "timeout");
    assert.match(r.hint!, /まだ参加していません/);
  });

  test("参加待ちのリトライは会話中と別に数える", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    j("receive", room, "--timeout", "1", "--as", "alice");
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    assert.equal(state.participants.alice.join_timeouts, 1);
    assert.equal(state.participants.alice.timeouts, 0);
  });

  test("相手が参加していれば待たずに返る", () => {
    const room = opened();
    const r = j("receive", room, "--as", "alpha");
    assert.equal(r.status, "your_turn");
    assert.match(r.hint!, /相手が参加しました/);
  });
});

describe("close の理由", () => {
  test("定義された理由だけを受ける", () => {
    const room = opened();
    const r = j("close", room, "--reason", "検証のため打ち切り", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.error, "invalid_argument");
    assert.equal(j("status", room).status, "open");
  });

  test("manual は通る", () => {
    const room = opened();
    assert.equal(j("close", room, "--reason", "manual", "--as", "alpha").closed_reason, "manual");
  });

  // 書ける理由と読める理由がずれると、自分で書いた room.json を壊れたものとして断る。
  for (const reason of CLOSED_REASONS) {
    test(`${reason} で閉じたルームを読み直せる`, () => {
      const room = opened();
      assert.equal(j("close", room, "--reason", reason, "--as", "alpha").closed_reason, reason);
      assert.equal(j("status", room, "--as", "alpha").ok, true);
    });
  }
});

describe("アイドルの掃除", () => {
  test("無音のまま放置されたルームは閉じられる", () => {
    const room = opened();
    makeStale(room);
    const r = j("status", room, "--as", "alpha");
    assert.equal(r.status, "closed");
    assert.equal(r.closed_reason, "idle");
  });

  test("新しいルームは掃除されない", () => {
    assert.equal(j("status", opened(), "--as", "alpha").status, "open");
  });

  // 席を外した人間が戻ったときに、閉じた理由が案内と食い違わないようにする。
  test("29 分の無音では閉じない", () => {
    const room = opened();
    idleFor(room, 29);
    assert.equal(j("status", room, "--as", "alpha").status, "open");
  });

  test("31 分の無音で閉じる", () => {
    const room = opened();
    idleFor(room, 31);
    assert.equal(j("status", room, "--as", "alpha").status, "closed");
  });

  test("ls も掃除の対象にする", () => {
    const room = opened();
    makeStale(room);
    assert.equal(j("ls").rooms![0].status, "closed");
  });

  test("掃除で閉じた理由を close が上書きしない", () => {
    const room = opened();
    makeStale(room);
    j("close", room, "--as", "alpha");
    assert.equal(roomState(room).closed_reason, "idle");
  });

  // check は全セッションのターン終了で走る。参加していないルームまで掃除すると、
  // 無関係なセッションが他人の状態を書き換える。
  test("参加していないセッションの check は掃除しない", () => {
    const room = opened();
    makeStale(room);
    assert.equal(run("check", "--as", "carol").code, 1);
    assert.equal(roomState(room).closed_reason, null);
  });

  test("参加しているセッションの check は掃除する", () => {
    const room = opened();
    makeStale(room);
    assert.equal(run("check", "--as", "alpha").code, 1);
    assert.equal(roomState(room).closed_reason, "idle");
  });
});

// 行為は参加の証拠として扱う。過去の無音を理由に、いま来た参加や発言を断らない。
describe("掃除は行為を断らない", () => {
  test("期限を過ぎていても join できる", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    idleFor(room, 31);
    const r = j("join", room, "--as", "beta");
    assert.equal(r.status, "open");
    assert.equal(roomState(room).status, "open");
  });

  test("期限を過ぎていても say が通る", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    idleFor(room, 31);
    assert.equal(say(room, "beta", "31 分かけて書いた本文", true).ok, true);
    assert.equal(j("status", room, "--as", "alpha").hops_used, 1);
  });

  // 相手が先に閉じていれば結果は同じになる。これだけでは足りないことを固定する。
  test("先に閉じられていれば断られる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    makeStale(room);
    run("check", "--as", "alpha");
    assert.equal(say(room, "beta", "31 分かけて書いた本文", true).ok, false);
  });
});

describe("断った本文を残す", () => {
  const refused = (): { room: string; reply: Reply } => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    return { room, reply: say(room, "beta", "書き上げた本文", true) };
  };

  // 閉じるのは時計の判断であり、書き上げた仕事まで消す理由にはならない。
  test("断ってもファイルには残す", () => {
    const { room, reply } = refused();
    assert.equal(reply.ok, false);
    assert.equal(reply.kept, "closed-0002-beta.md");
    const path = join(home, "rooms", room, "messages", reply.kept!);
    assert.match(readFileSync(path, "utf8"), /書き上げた本文/);
  });

  test("残した本文は発言として数えない", () => {
    const { room } = refused();
    const r = j("status", room, "--as", "alpha");
    assert.deepEqual(r.ignored, ["closed-0002-beta.md"]);
    assert.equal(r.hops_used, 1);
    assert.equal(r.unread!.beta, 0);
    assert.equal(r.turn, "beta");
  });

  test("場所を hint で伝える", () => {
    assert.match(refused().reply.hint!, /closed-0002-beta\.md/);
  });

  test("本文が渡されていなければ残すものは無い", () => {
    const room = opened();
    j("close", room, "--as", "alpha");
    const r = j("say", room, "--advanced", "true", "--as", "beta");
    assert.equal(r.kept, null);
  });
});

describe("時間切れの数え直し", () => {
  /** 上限の手前まで待った状態を作る。 */
  const setTimeouts = (room: string, name: string, count: number): void => {
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    state.participants[name].timeouts = count;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
  };

  test("相手の応答が届いたら回数は 0 に戻る", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(participantState(room, "alpha").timeouts, 1);
    say(room, "beta", "こちらの制約です", true);
    j("receive", room, "--as", "alpha");
    assert.equal(participantState(room, "alpha").timeouts, 0);
  });

  test("数え直した後は上限まで待てる", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    setTimeouts(room, "alpha", RETRY_LIMIT - 1);
    say(room, "beta", "こちらの制約です", true);
    j("receive", room, "--as", "alpha");
    say(room, "alpha", "では次の論点です", true);
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.equal(r.retries_left, RETRY_LIMIT - 1);
  });

  test("応答が届いた後の時間切れで会話を閉じない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    setTimeouts(room, "alpha", RETRY_LIMIT - 1);
    say(room, "beta", "こちらの制約です", true);
    j("receive", room, "--as", "alpha");
    say(room, "alpha", "では次の論点です", true);
    j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(roomState(room).closed_reason, null);
  });

  test("自分の発言だけでは数え直さない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    dropLastRead(room, "alpha");
    j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(participantState(room, "alpha").timeouts, 1);
  });
});

describe("発言の直後に落ちた場合", () => {
  test("自分の発言を相手の発言として返さない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    dropLastRead(room, "alpha");
    assert.equal(j("receive", room, "--timeout", "1", "--as", "alpha").status, "timeout");
  });

  test("既読の位置は落ちる前まで進む", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    dropLastRead(room, "alpha");
    j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(participantState(room, "alpha").last_read, 1);
  });

  test("相手には従来どおり届く", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    dropLastRead(room, "alpha");
    const r = j("receive", room, "--as", "beta");
    assert.equal(r.status, "message");
    assert.equal(r.messages!.length, 1);
  });
});

describe("閉じたルームと参加者の判定順", () => {
  const closedRoom = (): string => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    return room;
  };

  test("参加していない名前は閉じたルームでも断られる", () => {
    const r = j("say", closedRoom(), "--text", "x", "--advanced", "true", "--as", "mallory");
    assert.equal(r.error, "not_a_participant");
  });

  test("参加していない名前に要約を促さない", () => {
    const r = j("say", closedRoom(), "--text", "x", "--advanced", "true", "--as", "mallory");
    assert.notEqual(r.next, "report");
    assert.equal(r.log_path, undefined);
  });

  test("参加者には閉じている旨を返す", () => {
    const r = j("say", closedRoom(), "--text", "x", "--advanced", "true", "--as", "beta");
    assert.equal(r.error, "closed");
    assert.equal(r.next, "report");
  });
});

describe("--topic", () => {
  test("省略を断る", () => {
    const r = j("open", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.next, "retry");
  });

  test("断られたときルームは作られない", () => {
    j("open", "--as", "alpha");
    assert.equal(j("ls").rooms!.length, 0);
  });
});

describe("相手がいないルームの案内", () => {
  const alone = (): string => j("open", "--topic", TOPIC, "--as", "alpha").room_id!;

  for (const command of ["join", "status"]) {
    test(`${command} は断られる say を促さない`, () => {
      assert.equal(j(command, alone(), "--as", "alpha").next, "receive");
    });
  }

  test("相手の参加待ちであることを伝える", () => {
    assert.match(j("join", alone(), "--as", "alpha").hint!, /まだ参加していません/);
  });
});

// 同じ症状に原因が複数ある。1 つだけ名指しすると、正しい room_id を確かめた
// 人間がそこで詰まる。窓ごとに別の名前で言うのも、別の直し方を指示することになる。
describe("見つからないルーム", () => {
  test("探した場所を添える", () => {
    const hint = j("status", "r-0000", "--as", "alpha").hint!;
    assert.match(hint, /r-0000/);
    assert.match(hint, /rooms/);
  });

  test("room_id 以外の原因も並べる", () => {
    const hint = j("status", "r-0000", "--as", "alpha").hint!;
    assert.match(hint, /CXTALK_HOME/);
    assert.match(hint, /消された/);
  });

  test("置き場ごと無ければ見つからないとして返す", () => {
    assert.equal(j("status", "r-0000", "--as", "alpha").error, "no_such_room");
  });

  // ディレクトリだけ残っているのは、無いのではなく読めない。
  test("置き場だけ残っていれば読み取れないとして返す", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    rmSync(roomStatePath(room));
    assert.equal(j("status", room, "--as", "alpha").error, "corrupt_room");
  });

  test("ls と同じものを指す", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    rmSync(roomStatePath(room));
    assert.deepEqual(j("ls").unreadable, [room]);
    assert.equal(j("status", room, "--as", "alpha").error, "corrupt_room");
  });
});

describe("壊れた room.json", () => {
  const broken = (): string => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    writeFileSync(roomStatePath(room), "{ 壊れた", "utf8");
    return room;
  };

  for (const command of ["status", "join", "close", "receive"]) {
    test(`${command} は理由を JSON で返す`, () => {
      const r = j(command, broken(), "--as", "alpha");
      assert.equal(r.ok, false);
      assert.equal(r.error, "corrupt_room");
      assert.equal(r.next, "ask_user");
    });
  }

  test("say も理由を JSON で返す", () => {
    const r = j("say", broken(), "--text", "x", "--advanced", "true", "--as", "alpha");
    assert.equal(r.error, "corrupt_room");
  });

  test("異常終了として扱わない", () => {
    const r = run("status", broken(), "--as", "alpha");
    assert.equal(r.err, "");
    assert.equal(r.code, 0);
  });

  // 書いている最中の読みは空になる。読み直しても空なら、切り詰めではなく壊れている。
  test("空のままなら読み取れないとして返す", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    writeFileSync(roomStatePath(room), "", "utf8");
    assert.equal(j("status", room, "--as", "alpha").error, "corrupt_room");
  });

  test("ls は読めないルームを挙げる", () => {
    const room = broken();
    assert.deepEqual(j("ls").unreadable, [room]);
  });

  test("構文の問題として伝える", () => {
    assert.match(j("status", broken(), "--as", "alpha").hint!, /JSON として読み取れません/);
  });
});

describe("起きていない会話に要約を求めない", () => {
  // 閉じ方は no_response に限らない。掃除が先に当たれば、そのあとに相手が join してくる。
  const emptyClosed = (): string => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    makeStale(room);
    run("check", "--as", "alpha");
    return room;
  };

  for (const [label, call] of [
    ["join", (room: string) => j("join", room, "--as", "alpha")],
    ["status", (room: string) => j("status", room, "--as", "alpha")],
  ] as const) {
    test(`発言 0 件なら ${label} は要約を求めない`, () => {
      const hint = call(emptyClosed()).hint!;
      assert.doesNotMatch(hint, /合意できた点/);
      assert.match(hint, /room_id/);
    });
  }

  test("発言があれば要約を求める", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    assert.match(j("join", room, "--as", "alpha").hint!, /合意できた点/);
  });

  // 終わった会話の参加者一覧に、一度も発言していない名前を残さない。
  test("閉じたルームに参加者を足さない", () => {
    const room = emptyClosed();
    j("join", room, "--as", "beta");
    assert.deepEqual(Object.keys(participantsOf(room)), ["alpha"]);
  });
});

describe("room.json の知らないキー", () => {
  const withExtraKeys = (room: string): void => {
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    state.turn = "alpha";
    state.hops = 1;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
  };

  // 黙って無視すると、書き換えた人には反映されたように見える。
  for (const command of ["join", "status"]) {
    test(`${command} が読まなかったキーを名前で挙げる`, () => {
      const room = opened();
      withExtraKeys(room);
      const r = j(command, room, "--as", "beta");
      assert.deepEqual(r.unknown_keys, ["turn", "hops"]);
      assert.match(r.hint!, /turn \/ hops/);
    });
  }

  test("知らないキーがあっても会話は続けられる", () => {
    const room = opened();
    withExtraKeys(room);
    assert.equal(say(room, "alpha", "本文", true).ok, true);
  });

  test("知らないキーが無ければ触れない", () => {
    const r = j("status", opened(), "--as", "beta");
    assert.deepEqual(r.unknown_keys, []);
    assert.doesNotMatch(r.hint!, /読まないキー/);
  });
});

describe("状態ファイルの値", () => {
  /** 人間が room.json を手で直した状態を作る。上限を変える唯一の手段として案内している。 */
  const patched = (patch: (state: EditableRoom) => void): string => {
    const room = opened();
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8")) as EditableRoom;
    patch(state);
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    return room;
  };

  /**
   * こちらで決め直すと歯止めや発言権が黙って変わる値。欠けていても書き間違いでも断る。
   * 第 3 要素は hint が名指しすべき箇所。人間はこれを頼りに room.json を直すため、
   * 別の検査が先に拾って別の場所を告げると、正しく直しても直らない。
   */
  const rejected: [string, (state: EditableRoom) => void, RegExp][] = [
    ["max_hops が整数でない", (s) => void (s.max_hops = "5往復"), /max_hops/],
    ["max_hops が欠けている", (s) => void delete s.max_hops, /max_hops/],
    ["opener が欠けている", (s) => void delete s.opener, /opener/],
    ["opener が参加者にいない", (s) => void (s.opener = "zzz"), /opener/],
    ["status が open でも closed でもない", (s) => void (s.status = "paused"), /status/],
    ["last_activity_at が欠けている", (s) => void delete s.last_activity_at, /last_activity_at/],
    [
      "last_activity_at が日時として読めない",
      (s) => void (s.last_activity_at = "きのう"),
      /last_activity_at/,
    ],
    [
      "last_activity_at が文字列でない",
      (s) => void (s.last_activity_at = 0 as never),
      /last_activity_at/,
    ],
    ["開いたルームに closed_reason がある", (s) => void (s.closed_reason = "manual"), /closed_reason/],
    [
      "participants が配列",
      (s) => void ((s as Record<string, unknown>).participants = []),
      /participants/,
    ],
    ["id がディレクトリ名と違う", (s) => void (s.id = "r-0000"), /id がディレクトリ名/],
    ["last_read が整数でない", (s) => void (s.participants.alpha.last_read = "3"), /last_read/],
    [
      "参加者の状態が object でない",
      (s) => void ((s.participants as Record<string, unknown>).alpha = 3),
      /alpha の状態/,
    ],
  ];

  for (const [label, patch, reason] of rejected) {
    test(`${label} なら読み取れないものとして扱う`, () => {
      const r = j("status", patched(patch), "--as", "alpha");
      assert.equal(r.ok, false);
      assert.equal(r.error, "corrupt_room");
      assert.equal(r.next, "ask_user");
    });

    test(`${label} なら hint がその箇所を名指しする`, () => {
      assert.match(j("status", patched(patch), "--as", "alpha").hint!, reason);
    });
  }

  // 名指しだけでは直せない。満たすべき条件まで書けているかを 1 件で確かめる。
  test("hint は値の名前だけでなく満たすべき条件も書く", () => {
    const room = patched((s) => void (s.max_hops = "5往復"));
    assert.match(j("status", room, "--as", "alpha").hint!, /max_hops が 1 以上 \d+ 以下の整数ではありません/);
  });

  test("閉じたルームの closed_reason が定義された値でなければ断る", () => {
    const room = opened();
    j("close", room, "--as", "alpha");
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8")) as EditableRoom;
    state.closed_reason = "飽きたから";
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    assert.equal(j("status", room, "--as", "alpha").error, "corrupt_room");
  });

  test("寄せられる値は直し方も添える", () => {
    const room = patched((s) => void (s.participants.alpha.last_read = "3"));
    assert.match(j("status", room, "--as", "alpha").hint!, /キーごと消せば 0 として読みます/);
  });

  test("実行時のエラーをそのまま人へ渡さない", () => {
    const room = patched((s) => void ((s.participants as Record<string, unknown>).alpha = 3));
    const hint = j("status", room, "--as", "alpha").hint!;
    assert.match(hint, /alpha の状態が読み取れません/);
    assert.doesNotMatch(hint, /Cannot/);
  });

  test("上限が読めないルームでは会話を進めない", () => {
    const room = patched((s) => void (s.max_hops = "5往復"));
    assert.equal(say(room, "alpha", "ひとつめ", true).error, "corrupt_room");
  });

  test("last_read が欠けていれば全部未読として読む", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8")) as EditableRoom;
    delete state.participants.beta.last_read;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    assert.equal(j("status", room, "--as", "beta").unread!.beta, 1);
  });

  test("timeouts が欠けていれば 0 から数え直す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8")) as EditableRoom;
    delete state.participants.alpha.timeouts;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    assert.equal(
      j("receive", room, "--timeout", "1", "--as", "alpha").retries_left,
      RETRY_LIMIT - 1,
    );
  });
});

// hook が実装まで届いていない状態は、|| exit 0 に飲まれて外から観測できない。
// 届いた事実を残し、会話を始めるときに人間へ渡す。
describe("hook が届いた記録", () => {
  const record = (): string => join(home, "last_check");
  const asHook = (input: string): Run => {
    const cwd = join(home, "beta");
    mkdirSync(cwd, { recursive: true });
    return viaBash([HOOK], {
      input,
      cwd,
      env: {
        ...process.env,
        CXTALK_HOME: home,
        CLAUDE_CODE_SESSION_ID: sessionFor("beta"),
        PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
  };

  test("記録が無ければ open が伝える", () => {
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.hook_last_run, null);
    assert.match(r.hint!, /走った記録はありません/);
  });

  // 手で叩いた分を混ぜると、届いていない hook が届いたように見える。
  test("手で叩いた check は記録しない", () => {
    run("check", "--as", "alpha");
    assert.equal(existsSync(record()), false);
  });

  test("hook として走れば記録する", () => {
    opened();
    asHook(JSON.stringify({ stop_hook_active: false }));
    assert.equal(existsSync(record()), true);
  });

  // 控えが無いセッションは実装に届かない。届いていないのだから記録も残らない。
  test("控えが無いセッションでは記録しない", () => {
    asHook(JSON.stringify({ stop_hook_active: false }));
    assert.equal(existsSync(record()), false);
  });

  test("記録があれば open が時刻を渡す", () => {
    writeFileSync(record(), "2026-08-10T14:00:00+09:00\n", "utf8");
    const r = j("open", "--topic", TOPIC, "--as", "alpha");
    assert.equal(r.hook_last_run, "2026-08-10T14:00:00+09:00");
    assert.match(r.hint!, /2026-08-10T14:00:00/);
  });

  // 書いている最中の読みは空になる。壊れているほうではなく、無いほうへ倒す。
  test("読めない記録は無いものとして扱う", () => {
    writeFileSync(record(), "", "utf8");
    assert.equal(j("open", "--topic", TOPIC, "--as", "alpha").hook_last_run, null);
    writeFileSync(record(), "きのう\n", "utf8");
    assert.equal(j("open", "--topic", TOPIC, "--as", "alpha").hook_last_run, null);
  });

  // 古いかどうかを決める境目を持つと、会話していない期間が長いだけの置き場を
  // 壊れていると報告することになる。
  test("古い記録でも壊れているとは言わない", () => {
    writeFileSync(record(), "2020-01-01T00:00:00+09:00\n", "utf8");
    const hint = j("open", "--topic", TOPIC, "--as", "alpha").hint!;
    assert.match(hint, /2020-01-01/);
    assert.doesNotMatch(hint, /記録はありません/);
  });
});

// Stop hook は全セッションのターン終了で走る。会話していないセッションが
// 実装を読み込まずに引き返せるよう、控えの有無だけで判定できるようにする。
describe("会話しているセッションを控える", () => {
  const awake = (as: string): string => join(home, "awake", sessionFor(as));
  const namesIn = (as: string): string[] =>
    readFileSync(awake(as), "utf8").split("\n").filter((line) => line !== "");

  test("open が控える", () => {
    j("open", "--topic", TOPIC, "--as", "alpha");
    assert.deepEqual(namesIn("alpha"), ["alpha"]);
  });

  test("join が控える", () => {
    j("join", j("open", "--topic", TOPIC, "--as", "alpha").room_id!, "--as", "beta");
    assert.deepEqual(namesIn("beta"), ["beta"]);
  });

  // 再開すると id が変わる。会話の途中で控えを失っても、次の往復で戻る。
  test("say と receive でも控える", () => {
    const room = opened();
    rmSync(awake("alpha"), { force: true });
    say(room, "alpha", "最初の論点です", true);
    assert.deepEqual(namesIn("alpha"), ["alpha"]);
    rmSync(awake("beta"), { force: true });
    j("receive", room, "--timeout", "1", "--as", "beta");
    assert.deepEqual(namesIn("beta"), ["beta"]);
  });

  test("同じ名乗りを二度控えない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.deepEqual(namesIn("alpha"), ["alpha"]);
  });

  test("会話していないセッションには控えが無い", () => {
    opened();
    assert.equal(existsSync(awake("carol")), false);
  });

  // 参加者が 1 人でも残っていれば、相手はこれから発言しうる。
  test("開いているうちは控えを消さない", () => {
    opened();
    run("check", "--as", "alpha");
    assert.equal(existsSync(awake("alpha")), true);
  });

  test("閉じていても未読があれば控えを消さない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    run("check", "--as", "beta");
    assert.equal(existsSync(awake("beta")), true);
  });

  test("閉じて読み終えたら控えを消す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    j("join", room, "--as", "beta");
    run("check", "--as", "beta");
    assert.equal(existsSync(awake("beta")), false);
  });

  // 一部しか見ていない呼び出しで控えを捨てると、見なかったルームの用を落とす。
  test("--room を付けた check は控えを消さない", () => {
    const seen = opened();
    const unseen = opened();
    say(unseen, "alpha", "最初の論点です", true);
    run("check", "--as", "beta", "--room", seen);
    assert.equal(existsSync(awake("beta")), true);
  });

  // 名乗りは会話ごとに選べる。--as が無いときに 1 つしか見ないと取りこぼす。
  test("--as が無ければ控えた名乗りを全部見る", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    j("join", room, "--as", "beta");
    say(room, "alpha", "最初の論点です", true);
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "check"], {
      encoding: "utf8",
      env: { ...process.env, CXTALK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionFor("beta") },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout ?? "", new RegExp(room));
  });

  test("控えが無ければ作業ディレクトリの名前を名乗る", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    rmSync(awake("beta"), { force: true });
    const cwd = join(home, "beta");
    mkdirSync(cwd, { recursive: true });
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "check"], {
      encoding: "utf8",
      cwd,
      env: { ...process.env, CXTALK_HOME: home, CLAUDE_CODE_SESSION_ID: sessionFor("beta") },
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout ?? "", new RegExp(room));
  });
});

describe("check の表示", () => {
  const closedWithUnread = (): string => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    return room;
  };

  test("閉じたルームに残り往復数を出さない", () => {
    closedWithUnread();
    assert.doesNotMatch(run("check", "--as", "beta").out, /残り/);
  });

  test("閉じたルームは閉じていると伝える", () => {
    closedWithUnread();
    assert.match(run("check", "--as", "beta").out, /閉じています/);
  });

  test("開いているルームには残り往復数を出す", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.match(run("check", "--as", "beta").out, /残り/);
  });
});

describe("参加者名の長さと制御文字", () => {
  test("64 文字は通る", () => {
    assert.equal(j("open", "--topic", TOPIC, "--as", "n".repeat(64)).ok, true);
  });

  test("64 文字を超える名前を断る", () => {
    assert.equal(j("open", "--topic", TOPIC, "--as", "n".repeat(65)).ok, false);
  });

  test("拒否の理由に長さの条件を含める", () => {
    assert.match(j("open", "--topic", TOPIC, "--as", "n".repeat(65)).hint!, /64/);
  });

  test("長い名前をそのまま繰り返さない", () => {
    assert.ok(j("open", "--topic", TOPIC, "--as", "n".repeat(200)).hint!.length < 200);
  });

  // 表示すると見えないため、参加者一覧では見分けがつかない名前になる。
  for (const [label, code] of [
    ["DEL", 0x7f],
    ["C1", 0x85],
  ] as const) {
    test(`${label} を含む名前を断る`, () => {
      const name = `a${String.fromCodePoint(code)}b`;
      assert.equal(j("open", "--topic", TOPIC, "--as", name).ok, false);
    });
  }
});

describe("名乗りを取り違えたときの案内", () => {
  test("参加者の名前を示す", () => {
    const room = opened();
    const r = j("say", room, "--text", "x", "--advanced", "true", "--as", "carol");
    assert.deepEqual(r.participants, ["alpha", "beta"]);
  });

  // 満室では join できないため、join を促すと指示が循環する。
  test("満室では join を促さない", () => {
    const room = opened();
    const r = j("say", room, "--text", "x", "--advanced", "true", "--as", "carol");
    assert.doesNotMatch(r.hint!, /join してください/);
  });

  for (const command of ["say", "join"]) {
    test(`満室の ${command} は名乗りの指定を促す`, () => {
      const room = opened();
      const args =
        command === "say"
          ? [command, room, "--text", "x", "--advanced", "true", "--as", "carol"]
          : [command, room, "--as", "carol"];
      assert.match(j(...args).hint!, /--as/);
    });
  }
});

describe("発言のファイルに残る申告", () => {
  for (const advanced of [true, false]) {
    test(`advanced: ${advanced} がファイルに残り、読み戻せる`, () => {
      const room = opened();
      say(room, "alpha", "本文", advanced);
      assert.match(readFileSync(messagePath(room, "0001-alpha.md"), "utf8"), /\nadvanced: /);
      assert.equal(j("join", room, "--as", "beta").messages![0].advanced, advanced);
    });
  }

  // 境目は最初の一つを取る。ヘッダが at で始まるため、本文の区切り行より必ず先に来る。
  test("本文に区切り行があっても本文が切れない", () => {
    const room = opened();
    const text = "まえがき\n---\nあとがき";
    say(room, "alpha", text, true);
    assert.equal(j("join", room, "--as", "beta").messages![0].text, text);
  });

  // 申告の無い発言が既にある。欠けているものを false に寄せると、
  // そう申告していない発言に申告が付く。
  test("申告の無い発言は分からないものとして返す", () => {
    const room = opened();
    say(room, "alpha", "本文", true);
    const path = messagePath(room, "0001-alpha.md");
    const raw = readFileSync(path, "utf8");
    writeFileSync(path, raw.replace(/\nadvanced: (true|false)/, ""), "utf8");
    assert.equal(j("join", room, "--as", "beta").messages![0].advanced, null);
  });
});

// 添字への代入は __proto__ を own にしない。落ちると、参加したのに参加者にならない。
describe("継承したプロパティ名を代入で落とさない", () => {
  const joined = (): string => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    j("join", room, "--as", "__proto__");
    return room;
  };

  test("__proto__ でも参加者として残る", () => {
    assert.deepEqual(j("status", joined(), "--as", "alpha").participants, ["alpha", "__proto__"]);
  });

  test("__proto__ でも発言できる", () => {
    const room = joined();
    say(room, "alpha", "最初の論点です", true);
    assert.equal(say(room, "__proto__", "応答です", true).ok, true);
  });

  test("__proto__ の未読も数える", () => {
    const room = joined();
    say(room, "alpha", "最初の論点です", true);
    assert.equal(j("status", room, "--as", "alpha").unread!["__proto__"], 1);
  });

  test("--__proto__ は受け付けないフラグとして断る", () => {
    const r = j("ls", "--__proto__", "x");
    assert.equal(r.ok, false);
    assert.equal(r.next, "retry");
  });
});

describe("壊れた発言のファイル", () => {
  const withBody = (body: string): string => {
    const room = opened();
    say(room, "alpha", "本文", true);
    writeFileSync(messagePath(room, "0001-alpha.md"), body, "utf8");
    return room;
  };

  // 書いている最中の読みは空になる。読み直しても空なら、書いている最中ではなく壊れている。
  test("空のままなら読み取れないとして返す", () => {
    assert.equal(j("join", withBody(""), "--as", "beta").error, "corrupt_room");
  });

  test("ヘッダが無ければ読み取れないとして返す", () => {
    assert.equal(j("join", withBody("本文だけ\n"), "--as", "beta").error, "corrupt_room");
  });

  test("読み取れない発言もファイル名を挙げる", () => {
    const r = j("join", withBody(""), "--as", "beta");
    assert.match(r.hint!, /0001-alpha\.md/);
  });
});

describe("値を書き忘れてフラグ名を飲み込む", () => {
  test("フラグ名そのものは値として受けない", () => {
    const room = opened();
    const r = j("say", room, "--text", "--as", "--advanced", "true");
    assert.equal(r.ok, false);
    assert.equal(r.next, "retry");
  });

  test("断ったなら発言は残らない", () => {
    const room = opened();
    j("say", room, "--text", "--as", "--advanced", "true");
    assert.equal(j("status", room).unread!.beta, 0);
  });

  // 本文がハイフンで始まる場合を守るため、弾くのはフラグ名と同じ語だけに限る。
  for (const [label, text] of [
    ["水平線", "--- 区切り線から始まる本文"],
    ["箇条書き", "- 箇条書きから始まる本文"],
  ] as const) {
    test(`${label}で始まる本文は通す`, () => {
      const room = opened();
      assert.equal(say(room, "alpha", text, true).ok, true);
    });
  }
});

describe("未知のフラグ", () => {
  test("打ち間違いを既定値として飲み込まない", () => {
    const r = j("open", "--topic", TOPIC, "--max-hop", "3", "--as", "alpha");
    assert.equal(r.ok, false);
    assert.equal(r.next, "retry");
  });

  test("使えるフラグを示す", () => {
    const r = j("open", "--topic", TOPIC, "--max-hop", "3", "--as", "alpha");
    assert.match(r.hint!, /--max-hops/);
  });

  test("断られたときルームは作られない", () => {
    j("open", "--topic", TOPIC, "--max-hop", "3", "--as", "alpha");
    assert.equal(j("ls").rooms!.length, 0);
  });

  test("フラグを取らないコマンドは全て断る", () => {
    assert.equal(j("ls", "--as", "alpha").ok, false);
  });
});

describe("room_id の欠落", () => {
  // 呼び出した側が自力で直せる誤りなので、存在しないルームとして人間へ回さない。
  for (const command of ["join", "say", "receive", "status", "close"]) {
    test(`${command} は retry で断る`, () => {
      const r = j(command, "--as", "alpha");
      assert.equal(r.ok, false);
      assert.equal(r.next, "retry");
    });
  }
});

describe("コマンドの指定", () => {
  test("引数なしはコマンドの欠落として伝える", () => {
    const r = j();
    assert.equal(r.ok, false);
    assert.match(r.hint!, /コマンドが指定されていません/);
  });

  test("使えるコマンドを示す", () => {
    assert.match(j().hint!, /open/);
  });

  test("未対応のコマンドは retry で断る", () => {
    assert.equal(j("frobnicate").next, "retry");
  });
});

describe("最後の発言を先に伝える", () => {
  for (const command of ["receive", "join", "status"]) {
    test(`${command} は上限に達する発言の前に知らせる`, () => {
      const room = opened(1);
      say(room, "alpha", "最初の論点です", true);
      assert.match(j(command, room, "--as", "beta").hint!, /最後の発言/);
    });
  }

  test("余裕があるうちは知らせない", () => {
    const room = opened(5);
    say(room, "alpha", "最初の論点です", true);
    assert.doesNotMatch(j("receive", room, "--as", "beta").hint!, /最後の発言/);
  });

  test("相手の番なら知らせない", () => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    assert.doesNotMatch(j("status", room, "--as", "alpha").hint!, /最後の発言/);
  });

  /** 予告した発言と実際に閉じる発言がずれていないことを、上限を変えて確かめる。 */
  for (const maxHops of [1, 2, 3]) {
    test(`max-hops ${maxHops} でも知らせた発言でルームが閉じる`, () => {
      const room = opened(maxHops);
      for (let seq = 1; ; seq++) {
        const me = seq % 2 === 1 ? "alpha" : "beta";
        const notified = /最後の発言/.test(j("status", room, "--as", me).hint!);
        const r = say(room, me, `${seq} 番目`, true);
        assert.equal(notified, r.closed_reason === "hop_limit", `seq ${seq}`);
        if (r.status === "closed") break;
      }
    });
  }
});

describe("実行していない動作を報告しない", () => {
  test("既に閉じたルームには閉じたと言わない", () => {
    const room = opened();
    j("close", room, "--as", "alpha");
    assert.match(j("close", room, "--as", "alpha").hint!, /既に閉じています/);
  });
});

describe("一覧の案内", () => {
  test("ルームがあるとき次の行動を書く", () => {
    opened();
    assert.match(j("ls").hint!, /確認してください/);
  });

  test("ルームが無いときも次の行動を書く", () => {
    assert.match(j("ls").hint!, /open/);
  });
});

describe("報告へ移る経路の未読", () => {
  /** beta の最後の発言が alpha にとって未読のまま、上限で閉じた状態を作る。 */
  const closedWithUnread = (): string => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    j("receive", room, "--as", "beta");
    say(room, "beta", "最後の見解です", true);
    return room;
  };

  // 一部の経路だけが未読を渡す形だと、受け取らなかった側は
  // 未読が無いものとして相手の最終見解を読まずに要約する。
  const withUnread: [string, string[]][] = [
    ["say", ["--text", "x", "--advanced", "true"]],
    ["close", ["--reason", "manual"]],
    ["join", []],
    ["receive", []],
  ];

  for (const [command, args] of withUnread) {
    test(`${command} は未読を返す`, () => {
      const room = closedWithUnread();
      const r = j(command, room, ...args, "--as", "alpha");
      assert.equal(r.next, "report");
      assert.equal(r.messages!.length, 1);
      assert.equal(r.messages![0].text, "最後の見解です");
    });

    test(`${command} は未読があることを hint で伝える`, () => {
      const room = closedWithUnread();
      assert.match(j(command, room, ...args, "--as", "alpha").hint!, /未読が 1 件/);
    });

    test(`${command} で受け取った後は未読が残らない`, () => {
      const room = closedWithUnread();
      j(command, room, ...args, "--as", "alpha");
      assert.equal(j("status", room, "--as", "alpha").unread!.alpha, 0);
    });
  }

  // status は確認しただけで既読にしないことが役割なので、読む手段の方を伝える。
  test("status は未読を既読にしない", () => {
    const room = closedWithUnread();
    j("status", room, "--as", "alpha");
    assert.equal(j("status", room, "--as", "alpha").unread!.alpha, 1);
  });

  test("status は未読の件数と読む手段を hint に出す", () => {
    const room = closedWithUnread();
    const r = j("status", room, "--as", "alpha");
    assert.match(r.hint!, /未読が 1 件/);
    assert.match(r.hint!, /receive/);
  });

  test("未読がなければ件数を出さない", () => {
    const room = closedWithUnread();
    j("receive", room, "--as", "alpha");
    assert.doesNotMatch(j("status", room, "--as", "alpha").hint!, /未読/);
  });
});

describe("参加者が自分だけであることの案内", () => {
  // 同じ見立てが待機の上限にも書かれている。待たせてから告げると、
  // 待てる回数を使い切った後にしか届かない。
  const alone = (): string => j("open", "--topic", TOPIC, "--as", "alice").room_id!;

  for (const [label, call] of [
    ["join", (room: string) => j("join", room, "--as", "alice")],
    ["status", (room: string) => j("status", room, "--as", "alice")],
    [
      "say",
      (room: string) => j("say", room, "--text", "x", "--advanced", "true", "--as", "alice"),
    ],
  ] as const) {
    test(`${label} は待つ前に参加者が 1 人だと告げる`, () => {
      const hint = call(alone()).hint!;
      assert.match(hint, /1 人/);
      assert.match(hint, /--as/);
    });
  }

  // 2 人揃っていれば、名乗りを疑えという助言は正しくない。
  test("相手が来ていれば告げない", () => {
    assert.doesNotMatch(j("status", opened(), "--as", "alpha").hint!, /1 人/);
  });
});

// in と添字はプロトタイプチェーンにも答える。引き方が散ると、直す先を数え上げた
// 本人がその場で 1 つ落とす。close は状態を変えて取り消せないため、落とすと重い。
describe("継承したプロパティ名を参加者と取り違えない", () => {
  const inherited = ["toString", "constructor", "hasOwnProperty"];

  const conversing = (): string => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    return room;
  };

  for (const name of inherited) {
    test(`${name} は参加者として扱わない`, () => {
      const r = j("status", conversing(), "--as", name);
      // retries_left だけでは足りない。取り違えると NaN になり、JSON では同じ null になる。
      assert.equal(r.next, "ask_user");
      assert.equal(r.retries_left, null);
    });
  }

  for (const [label, call] of [
    ["close", (room: string) => j("close", room, "--as", "toString")],
    ["receive", (room: string) => j("receive", room, "--timeout", "1", "--as", "toString")],
    [
      "say",
      (room: string) => j("say", room, "--text", "x", "--advanced", "true", "--as", "toString"),
    ],
  ] as const) {
    test(`${label} は参加者でない名前を断る`, () => {
      const room = conversing();
      const r = call(room);
      assert.equal(r.ok, false);
      assert.equal(r.error, "not_a_participant");
      assert.equal(roomState(room).status, "open");
    });
  }
});

describe("参加していない名前への案内", () => {
  const oneParticipant = (): string => j("open", "--topic", TOPIC, "--as", "alice").room_id!;

  // room_id を取り違えていた場合、join すると無関係のルームへ 2 人目として入り、
  // 本来の相手を room_full で締め出すことになる。
  test("参加者が 1 人でも join を促さない", () => {
    const r = j("say", oneParticipant(), "--text", "x", "--advanced", "true", "--as", "carol");
    assert.equal(r.error, "not_a_participant");
    assert.doesNotMatch(r.hint!, /join してください/);
  });

  test("room_id の取り違えに触れる", () => {
    const r = j("say", oneParticipant(), "--text", "x", "--advanced", "true", "--as", "carol");
    assert.match(r.hint!, /room_id/);
  });
});

describe("待機の上限に達したときの案内", () => {
  test("参加待ちで尽きたときは名乗りの取り違えにも触れる", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    assert.match(exhaustWaits(room, "alice").hint!, /--as/);
  });

  // 2 人揃っている場面では、名乗りを疑えという助言は正しくない。
  test("会話中に尽きたときは名乗りに触れない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.doesNotMatch(exhaustWaits(room, "alpha").hint!, /--as/);
  });

  // 相手が一度も参加していなければ発言も無い。起きていない会話に要約を求めない。
  test("参加が成立しないまま閉じたら要約を求めない", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    const r = exhaustWaits(room, "alice");
    assert.equal(r.closed_reason, "no_response");
    assert.doesNotMatch(r.hint!, /合意できた点/);
  });

  test("代わりに room_id が伝わったかを確かめさせる", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    assert.match(exhaustWaits(room, "alice").hint!, /room_id/);
  });

  // 会話は終わっていない。要約を求めると、続けられる会話をそこで畳ませることになる。
  test("会話中に尽きたときは要約を求めない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.doesNotMatch(exhaustWaits(room, "alpha").hint!, /合意できた点/);
  });
});

describe("上限に達する発言が未読を捨てない", () => {
  // 発言権は seq から導けるため、相手の発言を受け取らないまま say できる。
  // last_read を自分の発言番号へ進めるので、先に控えないと読む手段が消える。
  test("hop_limit で閉じるとき未読を返す", () => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    const r = say(room, "beta", "読まずに応答します", true);
    assert.equal(r.closed_reason, "hop_limit");
    assert.equal(r.messages!.length, 1);
    assert.equal(r.messages![0].text, "最初の論点です");
  });

  test("stale で閉じるとき未読を返す", () => {
    const room = opened();
    say(room, "alpha", "同意します", false);
    const r = say(room, "beta", "こちらも同意です", false);
    assert.equal(r.closed_reason, "stale");
    assert.equal(r.messages!.length, 1);
  });

  test("未読があることを hint で伝える", () => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    assert.match(say(room, "beta", "読まずに応答します", true).hint!, /未読が 1 件/);
  });

  test("自分の発言は未読に含めない", () => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    const r = say(room, "beta", "読まずに応答します", true);
    assert.ok(r.messages!.every((m) => m.from !== "beta"));
  });

  test("読んでから発言すれば未読は付かない", () => {
    const room = opened(1);
    say(room, "alpha", "最初の論点です", true);
    j("receive", room, "--as", "beta");
    const r = say(room, "beta", "読んでから応答します", true);
    assert.equal(r.messages!.length, 0);
    assert.doesNotMatch(r.hint!, /未読/);
  });
});

describe("利用者が叩く入口", () => {
  /**
   * シェルがラッパーを起動するとき、インタプリタへ渡すのはスクリプト自身のパスであり、
   * その形は呼び方で変わる。名前空間の食い違う環境では開けない形が届くため、
   * シェルを並べるのではなく、届きうる形を並べて確かめる。
   */
  const invocations: [string, () => Run][] = [
    ["その環境が native と見なす絶対パス", () => bin("ls")],
    ["シェルの名前空間の絶対パス", () => inRepo('"$PWD/bin/cxtalk" ls')],
    ["パスの変換が止められた状態", () => inRepo('"$PWD/bin/cxtalk" ls', { MSYS_NO_PATHCONV: "1" })],
    ["相対パス", () => inRepo("./bin/cxtalk ls")],
  ];

  for (const [label, invoke] of invocations) {
    test(`${label}で叩いても実装に届く`, () => {
      assert.equal(JSON.parse(invoke().out).ok, true);
    });
  }

  test("警告を標準エラーに出さない", () => {
    assert.equal(bin("ls").err, "");
  });

  test("引数をそのまま実装へ渡す", () => {
    const r = JSON.parse(bin("open", "--topic", TOPIC, "--as", "alpha").out);
    assert.equal(r.topic, TOPIC);
    assert.equal(r.as, "alpha");
  });
});

describe("名乗りの表現を一つに寄せる", () => {
  // 見た目が同じでも合成済みと分解済みで別の文字列になる。寄せないと別人として断られ、
  // エラー文と参加者一覧に同じ字面が並ぶ。
  const NFC = "José";
  const NFD = "José";

  test("表現の違う同じ名前は同じ参加者として扱う", () => {
    const room = j("open", "--topic", TOPIC, "--as", NFC).room_id!;
    j("join", room, "--as", "beta");
    assert.equal(j("say", room, "--text", "x", "--advanced", "true", "--as", NFD).ok, true);
  });

  test("どちらで名乗っても保存は一つの表現になる", () => {
    const room = j("open", "--topic", TOPIC, "--as", NFD).room_id!;
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
    assert.deepEqual(Object.keys(state.participants), [NFC]);
  });

  test("再入場でも同じ参加者として扱う", () => {
    const room = j("open", "--topic", TOPIC, "--as", NFC).room_id!;
    j("join", room, "--as", "beta");
    assert.equal(j("join", room, "--as", NFD).rejoined, true);
  });

  // 名前はファイル名を経由して戻る。保存した綴りを変える環境がある。
  test("ファイル名の表現が変わっても自分の発言を未読にしない", () => {
    const room = j("open", "--topic", TOPIC, "--as", NFC).room_id!;
    j("join", room, "--as", "beta");
    say(room, NFC, "ひとつめ", true);
    const dir = join(home, "rooms", room, "messages");
    const before = join(dir, `0001-${NFC}.md`);
    renameSync(before, join(dir, `0001-${NFD}.md`));
    assert.equal(j("status", room, "--as", NFC).unread![NFC], 0);
  });
});

describe("置き場と上限の値", () => {
  const withHome = (value: string, ...args: string[]): Run => {
    const r = spawnSync(
      process.execPath,
      ["--disable-warning=ExperimentalWarning", CLI, ...args],
      { encoding: "utf8", cwd: home, env: { ...process.env, CXTALK_HOME: value } },
    );
    return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
  };

  // 同じ設定でも呼ぶ場所で置き場が変わる。開いたルームが見つからなくなる。
  test("相対パスの置き場は断る", () => {
    const r = JSON.parse(withHome("./ctk", "open", "--topic", TOPIC, "--as", "alpha").out);
    assert.equal(r.error, "invalid_home");
    assert.equal(r.next, "ask_user");
  });

  test("断る理由に設定されている値を書く", () => {
    assert.match(JSON.parse(withHome("./ctk", "ls").out).hint, /\.\/ctk/);
  });

  test("check は JSON を足さず終了コードで答える", () => {
    const r = withHome("./ctk", "check", "--as", "alpha");
    assert.equal(r.code, 2);
    assert.equal(r.out, "");
  });

  test("絶対パスの置き場は通る", () => {
    assert.equal(JSON.parse(withHome(join(home, "ctk"), "ls").out).ok, true);
  });

  // 通し番号は 4 桁でファイル名に綴る。桁を超えると並び順も発言者も変わる。
  test("桁に収まらない往復数は断る", () => {
    const r = j("open", "--topic", TOPIC, "--max-hops", "5000", "--as", "alpha");
    assert.equal(r.error, "invalid_argument");
    assert.match(r.hint!, /4999/);
  });

  test("桁に収まる往復数は通る", () => {
    assert.equal(j("open", "--topic", TOPIC, "--max-hops", "4999", "--as", "alpha").max_hops, 4999);
  });

  test("書き換えた往復数も同じ範囲で受ける", () => {
    const room = opened();
    const state = JSON.parse(readFileSync(roomStatePath(room), "utf8")) as EditableRoom;
    state.max_hops = 5000;
    writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
    assert.equal(j("status", room, "--as", "alpha").error, "corrupt_room");
  });

  // 先の時刻だと無音の長さが負になり、掃除が永久に効かない。
  test("先の時刻を指す最終更新は断る", () => {
    const room = opened();
    idleFor(room, -60);
    const r = j("status", room, "--as", "alpha");
    assert.equal(r.error, "corrupt_room");
    assert.match(r.hint!, /先の時刻/);
  });
});

describe("発言のファイルを検算する", () => {
  /** log_path は人に見に行けと案内している場所なので、関係ないファイルが増えうる。 */
  const withFile = (name: string, body = "memo\n"): string => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    writeFileSync(join(home, "rooms", room, "messages", name), body, "utf8");
    return room;
  };

  const notMessages = ["notes.md", "Untitled.md", "0002beta.md", "002-beta.md", "0002-123.md"];

  for (const name of notMessages) {
    test(`${name} は発言として数えない`, () => {
      const r = j("status", withFile(name), "--as", "alpha");
      assert.equal(r.hops_left, 4);
      assert.equal(r.unread!.beta, 1);
    });
  }

  test("数えなかったファイルを status が挙げる", () => {
    assert.deepEqual(j("status", withFile("notes.md"), "--as", "alpha").ignored, ["notes.md"]);
  });

  test("数えなかったファイルを join が挙げる", () => {
    assert.deepEqual(j("join", withFile("notes.md"), "--as", "beta").ignored, ["notes.md"]);
  });

  test("数えなかったことを hint でも伝える", () => {
    assert.match(j("status", withFile("notes.md"), "--as", "alpha").hint!, /notes\.md/);
  });

  test("何も落としていなければ ignored は空", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    assert.deepEqual(j("status", room, "--as", "alpha").ignored, []);
  });

  // 通し番号が詰まっていることは、発言権と往復数の導出が既に仮定している。
  test("通し番号に穴があれば断る", () => {
    const r = j("status", withFile("9999-alpha.md"), "--as", "alpha");
    assert.equal(r.error, "corrupt_room");
    assert.match(r.hint!, /通し番号/);
  });

  test("ヘッダの無い発言は断る", () => {
    const room = withFile("0002-beta.md", "ヘッダが無い。\n");
    const r = j("receive", room, "--as", "alpha");
    assert.equal(r.error, "corrupt_room");
  });

  // room.json を見に行かせないために、開くべきファイルを名指しする。
  test("断るときにどのファイルかを言う", () => {
    const room = withFile("0002-beta.md", "ヘッダが無い。\n");
    assert.match(j("receive", room, "--as", "alpha").hint!, /0002-beta\.md/);
  });

  test("形の合わないファイルは断る理由にしない", () => {
    assert.equal(j("status", withFile("notes.md"), "--as", "alpha").ok, true);
  });
});

describe("返せない状況でも約束を守る", () => {
  /**
   * 標準出力に JSON を 1 行返して 0 で終わることは、呼び出し側との約束である。
   * 状況はテスト自身が作る。書き込めない場所は、ディレクトリの位置にファイルを置いて作る。
   */
  const contract = (r: Run): Reply => {
    assert.equal(r.code, 0, "終了コードが 0 でない");
    assert.equal(r.err, "", "標準エラーに何か出ている");
    assert.equal(r.out.trimEnd().split("\n").length, 1, "標準出力が 1 行でない");
    return JSON.parse(r.out);
  };

  test("置き場所がファイルなら書けないものとして返す", () => {
    const file = join(home, "not-a-directory");
    writeFileSync(file, "", "utf8");
    const r = spawnSync(process.execPath, ["--disable-warning=ExperimentalWarning", CLI, "open", "--topic", TOPIC, "--as", "alpha"], {
      encoding: "utf8",
      env: { ...process.env, CXTALK_HOME: file },
    });
    const reply = contract({ out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 });
    assert.equal(reply.error, "unwritable");
    assert.equal(reply.next, "ask_user");
  });

  test("発言の置き場所が消えていたら書けないものとして返す", () => {
    const room = opened();
    rmSync(join(home, "rooms", room, "messages"), { recursive: true, force: true });
    const reply = contract(run("say", room, "--text", "x", "--advanced", "true", "--as", "alpha"));
    assert.equal(reply.error, "unwritable");
  });

  test("書けない場所を hint で名指しする", () => {
    const room = opened();
    rmSync(join(home, "rooms", room, "messages"), { recursive: true, force: true });
    const reply = JSON.parse(run("say", room, "--text", "x", "--advanced", "true", "--as", "alpha").out);
    assert.match(reply.hint, /0001-alpha\.md/);
    assert.match(reply.hint, /権限/);
  });

  test("発言のファイルがディレクトリでも JSON で返す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    mkdirSync(join(home, "rooms", room, "messages", "0002-beta.md"), { recursive: true });
    const reply = contract(run("receive", room, "--as", "alpha"));
    assert.equal(reply.ok, false);
    assert.equal(reply.next, "ask_user");
  });

  test("名前の付かない失敗は元の文言を添えて人へ渡す", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    mkdirSync(join(home, "rooms", room, "messages", "0002-beta.md"), { recursive: true });
    const reply = JSON.parse(run("receive", room, "--as", "alpha").out);
    assert.equal(reply.error, "unexpected_failure");
    assert.match(reply.hint, /EISDIR/);
  });

});

describe("Stop hook", () => {
  const active = (value: boolean): string =>
    JSON.stringify({ session_id: "s-1", stop_hook_active: value });

  /** beta に未読がある状態を作る。hook は名乗りを作業ディレクトリから決める。 */
  const unreadForBeta = (): string => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    return room;
  };

  test("未読があればターンの終了を止める", () => {
    const room = unreadForBeta();
    const r = stopHook(active(false), "beta");
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(room));
  });

  test("未読がなければ止めない", () => {
    opened();
    assert.equal(stopHook(active(false), "beta").code, 0);
  });

  test("相手の番なら止めない", () => {
    unreadForBeta();
    assert.equal(stopHook(active(false), "alpha").code, 0);
  });

  // これが効かないと、止めた先で再び止まり続けて会話から抜けられなくなる。
  test("hook 自身が起こしたターンでは止めない", () => {
    unreadForBeta();
    assert.equal(stopHook(active(true), "beta").code, 0);
  });

  // 待機の上限で閉じなくなったため、相手待ちのルームは開いたまま残る。
  // これで止まると、返事の来ない会話からターンを終えられなくなる。
  test("相手待ちのまま開いているルームでは止めない", () => {
    const room = unreadForBeta();
    exhaustWaits(room, "alpha");
    assert.equal(roomState(room).status, "open");
    assert.equal(stopHook(active(false), "alpha").code, 0);
  });

  // 閉じずに残す利点はここに出る。閉じていれば相手の say は入口で断られている。
  test("上限を過ぎてから届いた発言は拾う", () => {
    const room = unreadForBeta();
    exhaustWaits(room, "alpha");
    say(room, "beta", "遅れて届く見解です", true);
    const r = stopHook(active(false), "alpha");
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(room));
  });

  test("止めるときだけ標準エラーに理由を出す", () => {
    unreadForBeta();
    assert.equal(stopHook(active(false), "alpha").err, "");
  });

  // 判断できないときは止めない側へ倒す。止め続けると会話から抜けられなくなる。
  test("読めない入力では止めない", () => {
    unreadForBeta();
    assert.equal(stopHook("入力ではない", "beta").code, 0);
    assert.equal(stopHook("", "beta").code, 0);
  });

  // 値として読む。文字列の一致で判断すると、本文に同じ字面があるだけで空振りする。
  test("本文に同じ字面があっても判定を変えない", () => {
    const room = unreadForBeta();
    const input = JSON.stringify({
      stop_hook_active: false,
      last_assistant_message: '"stop_hook_active": true と書いた',
    });
    const r = stopHook(input, "beta");
    assert.equal(r.code, 2);
    assert.match(r.err, new RegExp(room));
  });

  test("入れ子の中の同じキーに引きずられない", () => {
    unreadForBeta();
    const input = JSON.stringify({ stop_hook_active: false, nested: { stop_hook_active: true } });
    assert.equal(stopHook(input, "beta").code, 2);
  });

  // 控えが無いセッションは実装を読み込まずに引き返す。全セッションで走るため、
  // ここを通すと会話していないセッションが毎ターン起動の費用を払う。
  test("控えが無ければ実装を起動しない", () => {
    unreadForBeta();
    rmSync(join(home, "awake", sessionFor("beta")), { force: true });
    assert.equal(stopHook(active(false), "beta").code, 0);
  });

  test("セッションが分からなければ止めない", () => {
    unreadForBeta();
    const cwd = join(home, "beta");
    mkdirSync(cwd, { recursive: true });
    const r = viaBash([HOOK], {
      input: active(false),
      cwd,
      env: {
        ...process.env,
        CXTALK_HOME: home,
        CLAUDE_CODE_SESSION_ID: "",
        PATH: `${BIN_DIR}${delimiter}${process.env.PATH ?? ""}`,
      },
    });
    assert.equal(r.code, 0);
  });
});

import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cxtalk.ts");

type Message = { seq: number; from: string; at: string; text: string };

type Reply = {
  ok: boolean;
  next?: "say" | "receive" | "report" | "ask_user" | "retry";
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
  retries_left?: number;
  waited_seconds?: number;
  unread?: Record<string, number>;
  participants?: string[];
  last_activity_at?: string;
  log_path?: string;
  rooms?: { room_id: string; log_path: string }[];
  unreadable?: string[];
};

type ParticipantState = { last_read: number; timeouts: number; join_timeouts: number };

type Run = { out: string; err: string; code: number };

let home: string;

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "cxtalk-test-"));
});

afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const run = (...args: string[]): Run => {
  const r = spawnSync(
    process.execPath,
    ["--disable-warning=ExperimentalWarning", CLI, ...args],
    { encoding: "utf8", env: { ...process.env, CXTALK_HOME: home } },
  );
  return { out: r.stdout ?? "", err: r.stderr ?? "", code: r.status ?? -1 };
};

const j = (...args: string[]): Reply => JSON.parse(run(...args).out);

const TOPIC = "確認テストの合格基準は正答数か正答率か";

/** alpha がルームを開き、beta が参加した状態を作る。 */
const opened = (maxHops = 5): string => {
  const room = j("open", "--topic", TOPIC, "--max-hops", String(maxHops), "--as", "alpha");
  j("join", room.room_id!, "--as", "beta");
  return room.room_id!;
};

const say = (room: string, as: string, text: string, advanced: boolean): Reply =>
  j("say", room, "--text", text, "--advanced", String(advanced), "--as", as);

const roomStatePath = (room: string): string => join(home, "rooms", room, "room.json");

const roomState = (room: string): { closed_reason: string | null } =>
  JSON.parse(readFileSync(roomStatePath(room), "utf8"));

const participantState = (room: string, name: string): ParticipantState =>
  JSON.parse(readFileSync(roomStatePath(room), "utf8")).participants[name];

/** 発言を書いてから状態を書くまでの間で落ちた状態を作る。 */
const dropLastRead = (room: string, name: string): void => {
  const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
  state.participants[name].last_read = 0;
  writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
};

/** 最終更新を十分に古くして、掃除の対象にする。 */
const makeStale = (room: string): void => {
  const state = JSON.parse(readFileSync(roomStatePath(room), "utf8"));
  state.last_activity_at = "2000-01-01T00:00:00+09:00";
  writeFileSync(roomStatePath(room), JSON.stringify(state), "utf8");
};

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
    assert.equal(r.retries_left, 5);
  });

  test("リトライを使い切ったら no_response で close", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    let last: Reply = {} as Reply;
    for (let i = 0; i < 7; i++) {
      last = j("receive", room, "--timeout", "1", "--as", "alpha");
      if (last.status === "closed") break;
    }
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
  test("副作用を持たず last_read を更新しない", () => {
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
});

describe("ls", () => {
  test("開いているルームを列挙する", () => {
    const a = opened();
    const b = opened();
    const out = run("ls").out;
    assert.match(out, new RegExp(a));
    assert.match(out, new RegExp(b));
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
    ]) {
      assert.equal(typeof r.ok, "boolean");
      assert.ok(["say", "receive", "report", "ask_user"].includes(r.next!));
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
    const r = j("close", room, "--as", "alpha");
    assert.ok(r.hint!.includes(r.log_path!));
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

  test("no_response は停止か長考かを断定しない", () => {
    const room = opened();
    say(room, "alpha", "ひとつめ", true);
    let last: Reply = {} as Reply;
    for (let i = 0; i < 7; i++) {
      last = j("receive", room, "--timeout", "1", "--as", "alpha");
      if (last.status === "closed") break;
    }
    assert.equal(last.closed_reason, "no_response");
    assert.match(last.hint!, /区別できません/);
    assert.ok(last.log_path!.includes(room));
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
});

describe("アイドルの掃除", () => {
  test("無音のまま放置されたルームは閉じられる", () => {
    const room = opened();
    makeStale(room);
    const r = j("join", room, "--as", "alpha");
    assert.equal(r.status, "closed");
    assert.equal(r.next, "report");
  });

  test("掃除の理由は idle", () => {
    const room = opened();
    makeStale(room);
    j("join", room, "--as", "alpha");
    assert.equal(roomState(room).closed_reason, "idle");
  });

  test("掃除されたルームには発言できない", () => {
    const room = opened();
    makeStale(room);
    assert.equal(say(room, "alpha", "まだ話したい", true).ok, false);
  });

  test("新しいルームは掃除されない", () => {
    const room = opened();
    assert.equal(j("join", room, "--as", "alpha").status, "open");
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
    setTimeouts(room, "alpha", 5);
    say(room, "beta", "こちらの制約です", true);
    j("receive", room, "--as", "alpha");
    say(room, "alpha", "では次の論点です", true);
    const r = j("receive", room, "--timeout", "1", "--as", "alpha");
    assert.equal(r.status, "timeout");
    assert.equal(r.retries_left, 5);
  });

  test("応答が届いた後の時間切れで会話を閉じない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    setTimeouts(room, "alpha", 5);
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

  test("ls は読めないルームを挙げる", () => {
    const room = broken();
    assert.deepEqual(j("ls").unreadable, [room]);
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
  const exhaust = (room: string, as: string): Reply => {
    let last: Reply = {} as Reply;
    for (let i = 0; i < 7; i++) {
      last = j("receive", room, "--timeout", "1", "--as", as);
      if (last.status === "closed") break;
    }
    return last;
  };

  test("参加待ちで尽きたときは名乗りの取り違えにも触れる", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alice").room_id!;
    assert.match(exhaust(room, "alice").hint!, /--as/);
  });

  // 2 人揃っている場面では、名乗りを疑えという助言は正しくない。
  test("会話中に尽きたときは名乗りに触れない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    assert.doesNotMatch(exhaust(room, "alpha").hint!, /--as/);
  });
});

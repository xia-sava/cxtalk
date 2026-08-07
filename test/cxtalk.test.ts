import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cxtalk.ts");

type Message = { seq: number; from: string; at: string; text: string };

type Reply = {
  ok: boolean;
  next?: "say" | "receive" | "report" | "ask_user";
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
};

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

  test("新規参加では全件を返す", () => {
    const room = j("open", "--topic", TOPIC, "--as", "alpha").room_id!;
    j("join", room, "--as", "beta");
    say(room, "alpha", "ひとつめ", true);
    say(room, "beta", "ふたつめ", true);
    const r = j("join", room, "--as", "gamma");
    assert.equal(r.messages!.length, 2);
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
  test("副作用を持たず last_read を更新しない", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("status", room);
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

  test("閉じたルームでは exit 1", () => {
    const room = opened();
    say(room, "alpha", "最初の論点です", true);
    j("close", room, "--as", "alpha");
    assert.equal(run("check", "--as", "beta").code, 1);
  });

  test("room.json が壊れていれば exit 2", () => {
    mkdirSync(join(home, "rooms", "r-broken"), { recursive: true });
    writeFileSync(join(home, "rooms", "r-broken", "room.json"), "{ 壊れた", "utf8");
    assert.equal(run("check", "--as", "alpha").code, 2);
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

  test("同名のままでは発言権が相手に渡らない", () => {
    const room = j("open", "--topic", TOPIC).room_id!;
    j("join", room);
    const r = j("say", room, "--text", "ひとりごと", "--advanced", "true");
    assert.equal(r.ok, true);
    assert.equal(r.turn, "cxtalk");
  });
});

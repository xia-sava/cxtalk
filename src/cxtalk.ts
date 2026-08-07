import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

type Next = "say" | "receive" | "report" | "ask_user";
type RoomStatus = "open" | "closed";
type ClosedReason = "hop_limit" | "stale" | "no_response" | "idle" | "manual";

type Participant = { last_read: number; timeouts: number };

type Room = {
  id: string;
  topic: string;
  status: RoomStatus;
  turn: string;
  hops: number;
  max_hops: number;
  stale_streak: number;
  last_activity_at: string;
  participants: Record<string, Participant>;
  closed_reason: ClosedReason | null;
};

type Message = { seq: number; from: string; at: string; text: string };

type Flags = Record<string, string>;

const DEFAULT_MAX_HOPS = 5;
const DEFAULT_TIMEOUT_SECONDS = 100;
const RETRY_LIMIT = 6;
const IDLE_MINUTES = 30;
const POLL_INTERVAL_MS = 200;

const homeDir = (): string => process.env.CXTALK_HOME ?? join(homedir(), "cxtalk");
const roomsDir = (): string => join(homeDir(), "rooms");
const roomDir = (id: string): string => join(roomsDir(), id);
const roomJsonPath = (id: string): string => join(roomDir(id), "room.json");
const messagesDir = (id: string): string => join(roomDir(id), "messages");

/** 人間が原文へ辿り着くための場所。要約を経ずに突き合わせられるようにする。 */
const logPath = (id: string): string => resolve(roomDir(id));

const pad = (n: number): string => String(n).padStart(2, "0");

const nowIso = (): string => {
  const d = new Date();
  const offset = -d.getTimezoneOffset();
  const sign = offset >= 0 ? "+" : "-";
  const abs = Math.abs(offset);
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}` +
    `T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
};

type Parsed = { command: string; positional: string[]; flags: Flags };

const parseArgv = (argv: string[]): Parsed => {
  const words: string[] = [];
  const flags: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined) {
      flags[key] = "true";
    } else {
      flags[key] = value;
      i++;
    }
  }
  return { command: words[0] ?? "", positional: words.slice(1), flags };
};

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
};

const readRoom = (id: string): Room | null => {
  const path = roomJsonPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Room;
};

const writeRoom = (room: Room): void => {
  writeFileSync(roomJsonPath(room.id), `${JSON.stringify(room, null, 2)}\n`, "utf8");
};

const messageFiles = (id: string): string[] => {
  const dir = messagesDir(id);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
};

const seqOfFile = (file: string): number => Number(file.slice(0, 4));
const senderOfFile = (file: string): string => file.slice(5, -3);

const latestSeq = (id: string): number => {
  const files = messageFiles(id);
  return files.length === 0 ? 0 : seqOfFile(files[files.length - 1]);
};

const readMessages = (id: string, after: number): Message[] =>
  messageFiles(id)
    .filter((file) => seqOfFile(file) > after)
    .map((file) => {
      const raw = readFileSync(join(messagesDir(id), file), "utf8");
      const headEnd = raw.indexOf("\n---\n");
      const body = raw.slice(headEnd + 5);
      return {
        seq: seqOfFile(file),
        from: senderOfFile(file),
        at: raw.slice(raw.indexOf("at: ") + 4, headEnd),
        text: body.endsWith("\n") ? body.slice(0, -1) : body,
      };
    });

const writeMessage = (id: string, seq: number, from: string, text: string): void => {
  const file = `${String(seq).padStart(4, "0")}-${from}.md`;
  writeFileSync(join(messagesDir(id), file), `---\nat: ${nowIso()}\n---\n${text}\n`, "utf8");
};

const selfName = (flags: Flags): string => flags.as ?? basename(process.cwd());

const hopsOf = (seq: number): number => Math.ceil(seq / 2);

/** 1 以上の整数だけを受ける。不正なら null を返し、呼び出し側で断る。 */
const positiveInt = (raw: string | undefined, fallback: number): number | null => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : null;
};

const invalidArgument = (hint: string, id?: string): void => {
  emit({
    ok: false,
    error: "invalid_argument",
    ...(id === undefined ? {} : { room_id: id }),
    next: "ask_user",
    hint,
  });
};

const otherParticipant = (room: Room, me: string): string =>
  Object.keys(room.participants).find((name) => name !== me) ?? me;

const closeRoom = (room: Room, reason: ClosedReason): void => {
  room.status = "closed";
  room.closed_reason = reason;
  room.last_activity_at = nowIso();
  writeRoom(room);
};

/** 無音のまま放置されたルームを閉じる。 */
const sweepIdle = (room: Room): void => {
  if (room.status !== "open") return;
  const idleFor = Date.now() - new Date(room.last_activity_at).getTime();
  if (idleFor > IDLE_MINUTES * 60 * 1000) closeRoom(room, "idle");
};

const newRoomId = (): string => {
  for (;;) {
    const id = `r-${randomBytes(2).toString("hex")}`;
    if (!existsSync(roomDir(id))) return id;
  }
};

const cmdOpen = (flags: Flags): void => {
  const as = selfName(flags);
  const topic = flags.topic ?? "";
  const maxHops = positiveInt(flags["max-hops"], DEFAULT_MAX_HOPS);
  if (maxHops === null) {
    invalidArgument("--max-hops には 1 以上の整数を指定してください。");
    return;
  }
  const id = newRoomId();
  mkdirSync(messagesDir(id), { recursive: true });
  writeRoom({
    id,
    topic,
    status: "open",
    turn: as,
    hops: 0,
    max_hops: maxHops,
    stale_streak: 0,
    last_activity_at: nowIso(),
    participants: { [as]: { last_read: 0, timeouts: 0 } },
    closed_reason: null,
  });
  emit({
    ok: true,
    room_id: id,
    as,
    topic,
    max_hops: maxHops,
    turn: as,
    next: "ask_user",
    hint:
      `ルームを開きました。ユーザーに『相手のセッションで cxtalk join ${id} を実行するよう伝えてください』と` +
      `依頼してください。相手の参加を確認してから say で第一声を送ります。`,
  });
};

const CLOSING_HINT =
  "合意できた点・未解決の点・持ち帰る宿題を要約してユーザーに報告してください。" +
  "ここで出た結論は提案であり、実装はユーザーの承認を経てください。";

/** 会話を終えて報告に移らせる hint。原文の場所を必ず添える。 */
const reportHint = (id: string, head: string): string =>
  `${head}${CLOSING_HINT}原文は ${logPath(id)} に残っています。報告にこの場所を添えてください。`;

const joinHint = (id: string, closed: boolean, unread: number, rejoined: boolean, next: Next): string => {
  if (closed) return reportHint(id, "このルームは閉じています。");
  const head = `未読 ${unread} 件。${rejoined ? "再入場です。" : "参加しました。"}`;
  return next === "say"
    ? `${head}あなたの番です。say で発言してください。`
    : `${head}相手の発言を receive で待ってください。`;
};

const cmdJoin = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  const as = selfName(flags);
  const room = readRoom(id);
  if (!room) {
    emit({
      ok: false,
      error: "no_such_room",
      room_id: id,
      next: "ask_user",
      hint: `ルーム ${id} が見つかりません。room_id をユーザーに確認してください。`,
    });
    return;
  }
  sweepIdle(room);
  const rejoined = as in room.participants;
  if (!rejoined) room.participants[as] = { last_read: 0, timeouts: 0 };
  const messages = readMessages(id, rejoined ? room.participants[as].last_read : 0);
  room.participants[as].last_read = latestSeq(id);
  if (room.status === "open") room.last_activity_at = nowIso();
  writeRoom(room);
  const closed = room.status === "closed";
  const next: Next = closed ? "report" : room.turn === as ? "say" : "receive";
  emit({
    ok: true,
    room_id: id,
    as,
    rejoined,
    topic: room.topic,
    status: room.status,
    hops_left: room.max_hops - room.hops,
    messages,
    turn: room.turn,
    log_path: logPath(id),
    next,
    hint: joinHint(id, closed, messages.length, rejoined, next),
  });
};

const cmdSay = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  const as = selfName(flags);
  const room = readRoom(id);
  if (!room) {
    emit({
      ok: false,
      error: "no_such_room",
      room_id: id,
      next: "ask_user",
      hint: `ルーム ${id} が見つかりません。room_id をユーザーに確認してください。`,
    });
    return;
  }
  sweepIdle(room);
  if (room.status === "closed") {
    emit({
      ok: false,
      error: "closed",
      room_id: id,
      status: "closed",
      closed_reason: room.closed_reason,
      log_path: logPath(id),
      next: "report",
      hint: reportHint(id, "このルームは閉じています。"),
    });
    return;
  }
  if (Object.keys(room.participants).length < 2) {
    emit({
      ok: false,
      error: "alone_in_room",
      room_id: id,
      participants: Object.keys(room.participants),
      next: "ask_user",
      hint:
        "このルームにはまだ自分しかいません。相手が参加するまで発言できません。" +
        "同じ作業ディレクトリで複数のセッションを動かす場合は、--as で名乗り分けてください。",
    });
    return;
  }
  const text = flags.text;
  const advanced = flags.advanced;
  if (text === undefined) {
    emit({
      ok: false,
      error: "missing_argument",
      room_id: id,
      next: "ask_user",
      hint: "--text は必須です。発言の本文を渡してください。",
    });
    return;
  }
  if (advanced === undefined) {
    emit({
      ok: false,
      error: "missing_argument",
      room_id: id,
      next: "ask_user",
      hint:
        "--advanced は必須です。相手への同意・お礼・要約・確認だけの発言は " +
        "--advanced false を指定してください。",
    });
    return;
  }
  if (advanced !== "true" && advanced !== "false") {
    invalidArgument(
      `--advanced には true か false を指定してください。${advanced} は解釈できません。`,
      id,
    );
    return;
  }
  if (room.turn !== as) {
    emit({
      ok: false,
      error: "not_your_turn",
      room_id: id,
      turn: room.turn,
      next: "receive",
      hint: "今は相手の発言待ちです。receive を呼んでください。",
    });
    return;
  }

  const seq = latestSeq(id) + 1;
  writeMessage(id, seq, as, text);
  room.hops = hopsOf(seq);
  room.stale_streak = advanced === "true" ? 0 : room.stale_streak + 1;
  room.turn = otherParticipant(room, as);
  room.participants[as].last_read = seq;
  room.last_activity_at = nowIso();
  const hopsLeft = Math.max(0, room.max_hops - room.hops);

  const reason: ClosedReason | null =
    seq >= room.max_hops * 2 ? "hop_limit" : room.stale_streak >= 2 ? "stale" : null;

  if (reason) {
    closeRoom(room, reason);
    emit({
      ok: true,
      room_id: id,
      seq,
      hops_left: hopsLeft,
      status: "closed",
      closed_reason: reason,
      log_path: logPath(id),
      next: "report",
      hint: reportHint(
        id,
        reason === "hop_limit"
          ? "往復上限に達したのでルームを閉じました。この発言に相手は応答できません。"
          : "前に進む発言が続かなかったのでルームを閉じました。",
      ),
    });
    return;
  }

  writeRoom(room);
  emit({
    ok: true,
    room_id: id,
    seq,
    hops_left: hopsLeft,
    turn: room.turn,
    next: "receive",
    hint: "発言を記録しました。相手の応答を receive で待ってください。",
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/** 応答を返せる状態のルームがあれば、その出力を返す。無ければ null。 */
const pollOnce = (ids: string[], as: string): Record<string, unknown> | null => {
  for (const id of ids) {
    const room = readRoom(id);
    if (!room) continue;
    sweepIdle(room);
    if (room.status === "closed") {
      const participant = room.participants[as];
      const messages = readMessages(id, participant?.last_read ?? 0);
      if (participant && messages.length > 0) {
        participant.last_read = latestSeq(id);
        writeRoom(room);
      }
      return {
        ok: true,
        status: "closed",
        room_id: id,
        closed_reason: room.closed_reason,
        messages,
        log_path: logPath(id),
        next: "report",
        hint: reportHint(
          id,
          messages.length > 0
            ? `ルームは閉じています。未読が ${messages.length} 件あります。相手の最後の見解を読んでから要約してください。`
            : "ルームは閉じています。",
        ),
      };
    }
    const participant = room.participants[as];
    const seen = participant?.last_read ?? 0;
    const latest = latestSeq(id);
    if (latest > seen) {
      const messages = readMessages(id, seen);
      if (participant) participant.last_read = latest;
      room.last_activity_at = nowIso();
      writeRoom(room);
      return {
        ok: true,
        status: "message",
        room_id: id,
        messages,
        hops_left: Math.max(0, room.max_hops - room.hops),
        turn: room.turn,
        next: "say",
        hint: "相手の発言が届きました。内容を踏まえて say で応答してください。",
      };
    }
    if (room.turn === as) {
      return {
        ok: true,
        status: "your_turn",
        room_id: id,
        next: "say",
        hint: "あなたの発言番です。待たずに say を呼んでください。",
      };
    }
  }
  return null;
};

const cmdReceive = async (positional: string[], flags: Flags): Promise<void> => {
  const ids = positional;
  const as = selfName(flags);

  if (ids.length > 1) {
    emit({
      ok: false,
      error: "multiple_rooms",
      next: "ask_user",
      hint:
        "複数ルームの同時待機には対応していません。room_id を 1 つだけ指定して呼び直してください。",
    });
    return;
  }
  if (ids.length === 0 || readRoom(ids[0]) === null) {
    emit({
      ok: false,
      error: "no_such_room",
      next: "ask_user",
      hint: "待ち受けるルームが見つかりません。room_id をユーザーに確認してください。",
    });
    return;
  }
  const timeout = positiveInt(flags.timeout, DEFAULT_TIMEOUT_SECONDS);
  if (timeout === null) {
    invalidArgument("--timeout には 1 以上の整数を指定してください。", ids[0]);
    return;
  }

  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const reply = pollOnce(ids, as);
    if (reply) {
      emit(reply);
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  let retriesLeft = RETRY_LIMIT;
  for (const id of ids) {
    const room = readRoom(id);
    const participant = room?.participants[as];
    if (!room || !participant) continue;
    participant.timeouts += 1;
    writeRoom(room);
    retriesLeft = Math.min(retriesLeft, RETRY_LIMIT - participant.timeouts);
  }

  if (retriesLeft <= 0) {
    for (const id of ids) {
      const room = readRoom(id);
      if (room && room.status === "open") closeRoom(room, "no_response");
    }
    emit({
      ok: true,
      status: "closed",
      room_id: ids[0],
      closed_reason: "no_response",
      log_path: logPath(ids[0]),
      next: "report",
      hint: reportHint(
        ids[0],
        "待機の上限に達したためルームを閉じました。相手が停止したのか、まだ考えているのかは区別できません。" +
          "どちらであるかを断定せず、応答が得られなかった事実として報告してください。",
      ),
    });
    return;
  }

  emit({
    ok: true,
    status: "timeout",
    room_id: ids[0],
    waited_seconds: timeout,
    retries_left: retriesLeft,
    next: "receive",
    hint:
      `まだ応答がありません。時間切れは異常ではなく、長文を書く相手では普通に起きます。` +
      `receive を再度呼んでください。あと ${retriesLeft} 回待てます。`,
  });
};

const unreadOf = (room: Room): Record<string, number> => {
  const latest = latestSeq(room.id);
  const unread: Record<string, number> = {};
  for (const name of Object.keys(room.participants)) {
    unread[name] = Math.max(0, latest - room.participants[name].last_read);
  }
  return unread;
};

const notFound = (id: string): void => {
  emit({
    ok: false,
    error: "no_such_room",
    room_id: id,
    next: "ask_user",
    hint: `ルーム ${id} が見つかりません。room_id をユーザーに確認してください。`,
  });
};

/** 状態を読むだけで書き換えない。確認しただけで既読になるのを避ける。 */
const cmdStatus = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  const room = readRoom(id);
  if (!room) {
    notFound(id);
    return;
  }
  const as = selfName(flags);
  const unread = unreadOf(room);
  const next: Next =
    room.status === "closed" ? "report" : room.turn === as ? "say" : "receive";
  emit({
    ok: true,
    room_id: id,
    status: room.status,
    topic: room.topic,
    turn: room.turn,
    hops_left: Math.max(0, room.max_hops - room.hops),
    unread,
    participants: Object.keys(room.participants),
    last_activity_at: room.last_activity_at,
    log_path: logPath(id),
    next,
    hint:
      room.status === "closed"
        ? reportHint(id, "このルームは閉じています。")
        : `発言権は ${room.turn} にあります。残り ${Math.max(0, room.max_hops - room.hops)} 往復です。`,
  });
};

const cmdClose = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  const room = readRoom(id);
  if (!room) {
    notFound(id);
    return;
  }
  if (room.status === "open") closeRoom(room, (flags.reason ?? "manual") as ClosedReason);
  emit({
    ok: true,
    room_id: id,
    closed_reason: room.closed_reason,
    hops_used: room.hops,
    log_path: logPath(id),
    next: "report",
    hint: reportHint(id, "ルームを閉じました。"),
  });
};

const safeReadRoom = (id: string): Room | null => {
  try {
    return readRoom(id);
  } catch {
    return null;
  }
};

const cmdLs = (): void => {
  const dir = roomsDir();
  const ids = existsSync(dir) ? readdirSync(dir) : [];
  const rooms = ids
    .map(safeReadRoom)
    .filter((room): room is Room => room !== null)
    .map((room) => ({
      room_id: room.id,
      topic: room.topic,
      status: room.status,
      turn: room.turn,
      hops_left: Math.max(0, room.max_hops - room.hops),
      unread: unreadOf(room),
      last_activity_at: room.last_activity_at,
      log_path: logPath(room.id),
    }));
  emit({
    ok: true,
    rooms,
    next: "ask_user",
    hint: `${rooms.length} 件のルームがあります。`,
  });
};

/**
 * 用があれば 0、無ければ 1、状態を読めなければ 2 を返す。
 * 読めないファイルで恒久的に block されると復帰できないため、異常は安全側に倒す。
 */
const cmdCheck = (flags: Flags): void => {
  const as = selfName(flags);
  const only = flags.room;
  try {
    const dir = roomsDir();
    const ids = existsSync(dir) ? readdirSync(dir) : [];
    const lines: string[] = [];
    for (const id of ids) {
      if (only !== undefined && id !== only) continue;
      const room = readRoom(id);
      if (!room) continue;
      sweepIdle(room);
      if (room.turn !== as) continue;
      const participant = room.participants[as];
      if (!participant) continue;
      const files = messageFiles(id);
      const unread = latestSeq(id) - participant.last_read;
      if (unread <= 0) continue;
      const from = senderOfFile(files[files.length - 1]);
      const hopsLeft = Math.max(0, room.max_hops - room.hops);
      lines.push(`${id}: ${from} から ${unread} 件（残り${hopsLeft}往復）— ${room.topic}`);
    }
    if (lines.length === 0) {
      process.exitCode = 1;
      return;
    }
    console.log(lines.join("\n"));
    process.exitCode = 0;
  } catch {
    process.exitCode = 2;
  }
};

const { command, positional, flags } = parseArgv(process.argv.slice(2));

switch (command) {
  case "open":
    cmdOpen(flags);
    break;
  case "join":
    cmdJoin(positional, flags);
    break;
  case "say":
    cmdSay(positional, flags);
    break;
  case "receive":
    await cmdReceive(positional, flags);
    break;
  case "status":
    cmdStatus(positional, flags);
    break;
  case "close":
    cmdClose(positional, flags);
    break;
  case "ls":
    cmdLs();
    break;
  case "check":
    cmdCheck(flags);
    break;
  default:
    emit({
      ok: false,
      error: "unknown_command",
      next: "ask_user",
      hint: `${command} は未対応のコマンドです。`,
    });
}

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

type Next = "say" | "receive" | "report" | "ask_user" | "retry";
type RoomStatus = "open" | "closed";
type ClosedReason = "hop_limit" | "stale" | "no_response" | "idle" | "manual";

type Participant = { last_read: number; timeouts: number; join_timeouts: number };

type Room = {
  id: string;
  topic: string;
  status: RoomStatus;
  opener: string;
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
const MAX_PARTICIPANTS = 2;
const NAME_MAX_LENGTH = 64;

const CLOSED_REASONS: readonly string[] = [
  "hop_limit",
  "stale",
  "no_response",
  "idle",
  "manual",
];

/** コマンドごとに受け付けるフラグ。打ち間違いを既定値として飲み込まないために持つ。 */
const KNOWN_FLAGS: Record<string, readonly string[]> = {
  open: ["topic", "max-hops", "as"],
  join: ["as"],
  say: ["text", "advanced", "as"],
  receive: ["timeout", "as"],
  status: ["as"],
  close: ["reason", "as"],
  ls: [],
  check: ["as", "room"],
};

const COMMANDS = Object.keys(KNOWN_FLAGS);
const ALL_FLAGS = new Set(Object.values(KNOWN_FLAGS).flat());

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

type Parsed = { command: string; positional: string[]; flags: Flags; error?: string };

/** フラグは必ず値を取る。値の無いフラグは省略ではなく誤りとして返す。 */
const parseArgv = (argv: string[]): Parsed => {
  const words: string[] = [];
  const flags: Flags = {};
  let error: string | undefined;
  for (let i = 0; i < argv.length && error === undefined; i++) {
    const token = argv[i];
    if (!token.startsWith("--")) {
      words.push(token);
      continue;
    }
    const key = token.slice(2);
    const value = argv[i + 1];
    if (value === undefined) {
      error = `--${key} に値がありません。値を添えて呼び直してください。`;
      continue;
    }
    // 値がフラグ名そのものなら、書き忘れた値の代わりに次のフラグを飲み込んでいる。
    // 本文がハイフンで始まる場合を通すため、フラグ名と同じ語だけを誤りとする。
    if (value.startsWith("--") && ALL_FLAGS.has(value.slice(2))) {
      error =
        `--${key} の値がありません。${value} を値として受け取りました。` +
        `値を添えて呼び直してください。`;
      continue;
    }
    flags[key] = value;
    i++;
  }
  const command = words[0] ?? "";
  const known = KNOWN_FLAGS[command];
  if (error === undefined && known !== undefined) {
    const unknown = Object.keys(flags).filter((name) => !known.includes(name));
    if (unknown.length > 0) {
      error =
        `${command} は ${unknown.map((name) => `--${name}`).join(" と ")} を受け付けません。` +
        (known.length > 0
          ? `使えるのは ${known.map((name) => `--${name}`).join(" / ")} です。`
          : "このコマンドはフラグを受け付けません。");
    }
  }
  return { command, positional: words.slice(1), flags, error };
};

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
};

const readRoom = (id: string): Room | null => {
  const path = roomJsonPath(id);
  if (!existsSync(path)) return null;
  return JSON.parse(readFileSync(path, "utf8")) as Room;
};

/**
 * 読めないルームを飛ばして読む。一覧と検知は他のルームの結果を返す必要があり、
 * 1 件の破損で全件が失われると、未読があること自体が伝わらなくなる。
 */
const safeReadRoom = (id: string): Room | null => {
  try {
    return readRoom(id);
  } catch {
    return null;
  }
};

const writeRoom = (room: Room): void => {
  writeFileSync(roomJsonPath(room.id), `${JSON.stringify(room, null, 2)}\n`, "utf8");
};

const newParticipant = (): Participant => ({ last_read: 0, timeouts: 0, join_timeouts: 0 });

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

/**
 * 発言権は seq から導く。先手が偶数番、後手が奇数番を受け持つ。
 * 状態として持つと、発言の記録と発言権の受け渡しが別々の書き込みになり、
 * 間で落ちたときに誰も発言できないルームが残る。
 */
const turnOf = (room: Room, seq: number): string => {
  const names = Object.keys(room.participants);
  const opener = room.opener ?? names[0] ?? "";
  if (seq % 2 === 0) return opener;
  return names.find((name) => name !== opener) ?? opener;
};

const hopsLeftOf = (room: Room, seq: number): number =>
  Math.max(0, room.max_hops - hopsOf(seq));

/** 次の発言で上限に達し、相手が応答できなくなる状態か。 */
const isFinalTurn = (room: Room, seq: number): boolean => hopsLeftOf(room, seq) === 0;

const FINAL_TURN_NOTE =
  "これが最後の発言になります。相手は応答できないため、" +
  "合意していない点を合意したことにせず、対立は対立のまま書いてください。";

/** 発言を促す hint。上限に達する発言なら、書く前にそう伝える。 */
const sayHint = (room: Room, seq: number, head: string): string =>
  isFinalTurn(room, seq) ? `${head}${FINAL_TURN_NOTE}` : head;

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
    next: "retry",
    hint,
  });
};

/**
 * room_id が渡されていなければ retry で断って true。
 * 存在しないルームとして扱うと、呼び出した側が自力で直せる誤りを人間へ回すことになる。
 */
const rejectMissingRoom = (id: string): boolean => {
  if (id !== "") return false;
  invalidArgument("room_id が指定されていません。コマンドに room_id を添えて呼び直してください。");
  return true;
};

/**
 * 参加者名はメッセージのファイル名に埋まり、先手の判定にも使われる。
 * 数字だけの名前は状態を読み書きすると並び順が変わるため受けない。
 */
const isControl = (ch: string): boolean => {
  const code = ch.codePointAt(0) ?? 0;
  return code < 0x20 || (code >= 0x7f && code <= 0x9f);
};

const isValidName = (name: string): boolean =>
  name.length > 0 &&
  name.length <= NAME_MAX_LENGTH &&
  !/^\d+$/.test(name) &&
  !/^\.{1,2}$/.test(name) &&
  !/[\\/:*?"<>|]/.test(name) &&
  ![...name].some(isControl);

/** 名前が使えなければ理由を返して true。呼び出し側はそこで中断する。 */
const rejectInvalidName = (name: string): boolean => {
  if (isValidName(name)) return false;
  const shown = name.length > 32 ? `${name.slice(0, 32)}…` : name;
  invalidArgument(
    `参加者名 "${shown}" は使えません。1 文字以上 ${NAME_MAX_LENGTH} 文字以内で、` +
      `数字だけの名前、. と ..、ファイル名に使えない文字、制御文字を避けてください。` +
      `--as で別の名前を指定してください。`,
  );
  return true;
};

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

const notFound = (id: string): void => {
  emit({
    ok: false,
    error: "no_such_room",
    room_id: id,
    next: "ask_user",
    hint: `ルーム ${id} が見つかりません。room_id をユーザーに確認してください。`,
  });
};

const notAParticipant = (id: string, as: string, participants: string[]): void => {
  const full = participants.length >= MAX_PARTICIPANTS;
  emit({
    ok: false,
    error: "not_a_participant",
    room_id: id,
    participants,
    next: "ask_user",
    hint:
      `${as} はこのルームに参加していません。会話の読み書きは参加者に限られます。` +
      `参加しているのは ${participants.join(" と ")} です。` +
      (full
        ? `このどちらかとして続けるつもりなら --as にその名前を指定してください。` +
          `2 人が埋まっているため、別の名前では join できません。`
        : `名乗り分けをしているなら --as にその名前を指定し、` +
          `まだ入っていないなら join してください。`),
  });
};

const corruptRoom = (id: string): void => {
  emit({
    ok: false,
    error: "corrupt_room",
    room_id: id,
    log_path: logPath(id),
    next: "ask_user",
    hint:
      `ルーム ${id} の状態を読み取れません。room.json が壊れています。` +
      `${logPath(id)} をユーザーに確認してもらってください。`,
  });
};

/** ルームを読む。読めなければ理由に応じた応答を返して null を返す。 */
const loadRoom = (id: string): Room | null => {
  try {
    const room = readRoom(id);
    if (!room) notFound(id);
    return room;
  } catch {
    corruptRoom(id);
    return null;
  }
};

const CLOSING_HINT =
  "合意できた点・未解決の点・持ち帰る宿題を要約してユーザーに報告してください。" +
  "ここで出た結論は提案であり、実装はユーザーの承認を経てください。";

/** 会話を終えて報告に移らせる hint。原文の場所を必ず添える。 */
const reportHint = (id: string, head: string): string =>
  `${head}${CLOSING_HINT}原文は ${logPath(id)} に残っています。報告にこの場所を添えてください。`;

const cmdOpen = (flags: Flags): void => {
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const topic = flags.topic;
  if (topic === undefined) {
    invalidArgument("--topic は必須です。この会話で詰める論点を一つ渡してください。");
    return;
  }
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
    opener: as,
    max_hops: maxHops,
    stale_streak: 0,
    last_activity_at: nowIso(),
    participants: { [as]: newParticipant() },
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
      `依頼し、そのまま receive を呼んでください。相手が参加した時点で receive が返ります。`,
  });
};

const joinHint = (
  room: Room,
  seq: number,
  unread: number,
  rejoined: boolean,
  next: Next,
  alone: boolean,
): string => {
  if (room.status === "closed") return reportHint(room.id, "このルームは閉じています。");
  const head = `未読 ${unread} 件。${rejoined ? "再入場です。" : "参加しました。"}`;
  if (alone) return `${head}相手はまだ参加していません。receive を呼べば参加を待てます。`;
  return next === "say"
    ? sayHint(room, seq, `${head}あなたの番です。say で発言してください。`)
    : `${head}相手の発言を receive で待ってください。`;
};

const cmdJoin = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const room = loadRoom(id);
  if (!room) return;
  sweepIdle(room);
  const rejoined = as in room.participants;
  if (!rejoined && Object.keys(room.participants).length >= MAX_PARTICIPANTS) {
    emit({
      ok: false,
      error: "room_full",
      room_id: id,
      participants: Object.keys(room.participants),
      next: "ask_user",
      hint:
        `このルームには既に ${Object.keys(room.participants).join(" と ")} が参加しています。` +
        `3 人以上の会話には対応していません。` +
        `このどちらかとして続けるつもりなら --as にその名前を指定してください。` +
        `別の論点であれば新しいルームを開いてください。`,
    });
    return;
  }
  if (!rejoined) room.participants[as] = newParticipant();
  const messages = readMessages(id, room.participants[as].last_read);
  const seq = latestSeq(id);
  room.participants[as].last_read = seq;
  if (room.status === "open") room.last_activity_at = nowIso();
  writeRoom(room);
  const closed = room.status === "closed";
  const turn = turnOf(room, seq);
  // 相手がいないルームでは say が断られる。次の行動として示さない。
  const alone = Object.keys(room.participants).length < MAX_PARTICIPANTS;
  const next: Next = closed ? "report" : !alone && turn === as ? "say" : "receive";
  emit({
    ok: true,
    room_id: id,
    as,
    rejoined,
    topic: room.topic,
    status: room.status,
    hops_left: hopsLeftOf(room, seq),
    messages,
    turn,
    log_path: logPath(id),
    next,
    hint: joinHint(room, seq, messages.length, rejoined, next, alone),
  });
};

const cmdSay = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const room = loadRoom(id);
  if (!room) return;
  sweepIdle(room);
  // 参加者かどうかを先に見る。閉じたルームを先に見ると、
  // 参加していない相手に会話の要約と原文の場所を渡すことになる。
  if (!(as in room.participants)) {
    notAParticipant(id, as, Object.keys(room.participants));
    return;
  }
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
  if (Object.keys(room.participants).length < MAX_PARTICIPANTS) {
    emit({
      ok: false,
      error: "alone_in_room",
      room_id: id,
      participants: Object.keys(room.participants),
      next: "ask_user",
      hint:
        "このルームにはまだ自分しかいません。相手が参加するまで発言できません。" +
        "receive を呼べば参加を待てます。",
    });
    return;
  }
  const text = flags.text;
  const advanced = flags.advanced;
  if (text === undefined) {
    invalidArgument("--text は必須です。発言の本文を渡してください。", id);
    return;
  }
  if (advanced === undefined) {
    invalidArgument(
      "--advanced は必須です。相手への同意・お礼・要約・確認だけの発言は " +
        "--advanced false を指定してください。",
      id,
    );
    return;
  }
  if (advanced !== "true" && advanced !== "false") {
    invalidArgument(
      `--advanced には true か false を指定してください。${advanced} は解釈できません。`,
      id,
    );
    return;
  }
  const current = latestSeq(id);
  if (turnOf(room, current) !== as) {
    emit({
      ok: false,
      error: "not_your_turn",
      room_id: id,
      turn: turnOf(room, current),
      next: "receive",
      hint: "今は相手の発言待ちです。receive を呼んでください。",
    });
    return;
  }

  const seq = current + 1;
  writeMessage(id, seq, as, text);
  room.stale_streak = advanced === "true" ? 0 : room.stale_streak + 1;
  room.participants[as].last_read = seq;
  room.last_activity_at = nowIso();
  const hopsLeft = hopsLeftOf(room, seq);

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
    turn: turnOf(room, seq),
    next: "receive",
    hint: "発言を記録しました。相手の応答を receive で待ってください。",
  });
};

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => {
    setTimeout(done, ms);
  });

/** 応答を返せる状態なら出力を返す。まだ待つべきなら null。 */
const pollOnce = (id: string, as: string): Record<string, unknown> | null => {
  const room = safeReadRoom(id);
  if (!room) return null;
  sweepIdle(room);
  const seq = latestSeq(id);
  const participant = room.participants[as];

  if (room.status === "closed") {
    const messages = readMessages(id, participant?.last_read ?? 0);
    if (participant && messages.length > 0) {
      participant.last_read = seq;
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

  const seen = participant?.last_read ?? 0;
  if (seq > seen) {
    // 発言を書いてから状態を書くまでの間に落ちると、自分の発言が未読として残る。
    // そのまま返すと、自分が書いたものを相手の発言として読ませることになる。
    const messages = readMessages(id, seen).filter((message) => message.from !== as);
    if (participant) {
      participant.last_read = seq;
      // 相手の応答が届いた時点で待ち直しになる。時間切れは往復のたびに起きるため、
      // 数え続けると応答している相手との会話が打ち切られる。
      if (messages.length > 0) participant.timeouts = 0;
    }
    room.last_activity_at = nowIso();
    writeRoom(room);
    if (messages.length === 0) return null;
    return {
      ok: true,
      status: "message",
      room_id: id,
      messages,
      hops_left: hopsLeftOf(room, seq),
      turn: turnOf(room, seq),
      next: "say",
      hint: sayHint(room, seq, "相手の発言が届きました。内容を踏まえて say で応答してください。"),
    };
  }

  // 相手がまだ参加していない間は待ち続ける。
  if (Object.keys(room.participants).length < MAX_PARTICIPANTS) return null;

  if (turnOf(room, seq) === as) {
    return {
      ok: true,
      status: "your_turn",
      room_id: id,
      next: "say",
      hint: sayHint(
        room,
        seq,
        seq === 0
          ? "相手が参加しました。第一声を say で送ってください。"
          : "あなたの発言番です。待たずに say を呼んでください。",
      ),
    };
  }
  return null;
};

const cmdReceive = async (positional: string[], flags: Flags): Promise<void> => {
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  if (positional.length > 1) {
    emit({
      ok: false,
      error: "multiple_rooms",
      next: "retry",
      hint:
        "複数ルームの同時待機には対応していません。room_id を 1 つだけ指定して呼び直してください。",
    });
    return;
  }
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const opening = loadRoom(id);
  if (!opening) return;
  if (!(as in opening.participants)) {
    notAParticipant(id, as, Object.keys(opening.participants));
    return;
  }
  const timeout = positiveInt(flags.timeout, DEFAULT_TIMEOUT_SECONDS);
  if (timeout === null) {
    invalidArgument("--timeout には 1 以上の整数を指定してください。", id);
    return;
  }

  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    const reply = pollOnce(id, as);
    if (reply) {
      emit(reply);
      return;
    }
    if (Date.now() >= deadline) break;
    await sleep(POLL_INTERVAL_MS);
  }

  const room = loadRoom(id);
  if (!room) return;
  const participant = room.participants[as];
  if (!participant) {
    notAParticipant(id, as, Object.keys(room.participants));
    return;
  }

  // 参加を待っている間の時間切れは、会話中の長考とは別に数える。
  // 該当のフィールドを持たない状態ファイルもあるため、0 から数え直せる形で足す。
  const awaitingJoin = Object.keys(room.participants).length < MAX_PARTICIPANTS;
  if (awaitingJoin) participant.join_timeouts = (participant.join_timeouts ?? 0) + 1;
  else participant.timeouts = (participant.timeouts ?? 0) + 1;
  writeRoom(room);
  const retriesLeft = RETRY_LIMIT - (awaitingJoin ? participant.join_timeouts : participant.timeouts);

  if (retriesLeft <= 0) {
    if (room.status === "open") closeRoom(room, "no_response");
    emit({
      ok: true,
      status: "closed",
      room_id: id,
      closed_reason: "no_response",
      log_path: logPath(id),
      next: "report",
      hint: reportHint(
        id,
        awaitingJoin
          ? "待機の上限に達したためルームを閉じました。相手はまだ参加していません。room_id が伝わっていない可能性があります。"
          : "待機の上限に達したためルームを閉じました。相手が停止したのか、まだ考えているのかは区別できません。" +
              "どちらであるかを断定せず、応答が得られなかった事実として報告してください。",
      ),
    });
    return;
  }

  emit({
    ok: true,
    status: "timeout",
    room_id: id,
    waited_seconds: timeout,
    retries_left: retriesLeft,
    next: "receive",
    hint: awaitingJoin
      ? `相手がまだ参加していません。receive を再度呼んでください。あと ${retriesLeft} 回待てます。`
      : `まだ応答がありません。時間切れは異常ではなく、長文を書く相手では普通に起きます。` +
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

/** 状態を読むだけで書き換えない。確認しただけで既読になるのを避ける。 */
const cmdStatus = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const room = loadRoom(id);
  if (!room) return;
  const as = selfName(flags);
  const seq = latestSeq(id);
  const turn = turnOf(room, seq);
  const hopsLeft = hopsLeftOf(room, seq);
  const alone = Object.keys(room.participants).length < MAX_PARTICIPANTS;
  const next: Next =
    room.status === "closed" ? "report" : !alone && turn === as ? "say" : "receive";
  const standing = `発言権は ${turn} にあります。残り ${hopsLeft} 往復です。`;
  emit({
    ok: true,
    room_id: id,
    status: room.status,
    topic: room.topic,
    turn,
    hops_left: hopsLeft,
    unread: unreadOf(room),
    participants: Object.keys(room.participants),
    last_activity_at: room.last_activity_at,
    log_path: logPath(id),
    next,
    hint:
      room.status === "closed"
        ? reportHint(id, "このルームは閉じています。")
        : alone
          ? "相手はまだ参加していません。receive を呼べば参加を待てます。"
          : next === "say"
            ? sayHint(room, seq, standing)
            : standing,
  });
};

const cmdClose = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const room = loadRoom(id);
  if (!room) return;
  if (!(as in room.participants)) {
    notAParticipant(id, as, Object.keys(room.participants));
    return;
  }
  const reason = flags.reason ?? "manual";
  if (!CLOSED_REASONS.includes(reason)) {
    invalidArgument(
      `--reason には ${CLOSED_REASONS.join(" / ")} のいずれかを指定してください。` +
        `${reason} は解釈できません。`,
      id,
    );
    return;
  }
  const alreadyClosed = room.status === "closed";
  if (!alreadyClosed) closeRoom(room, reason as ClosedReason);
  emit({
    ok: true,
    room_id: id,
    closed_reason: room.closed_reason,
    hops_used: hopsOf(latestSeq(id)),
    log_path: logPath(id),
    next: "report",
    hint: reportHint(
      id,
      alreadyClosed ? "このルームは既に閉じています。" : "ルームを閉じました。",
    ),
  });
};

const cmdLs = (): void => {
  const dir = roomsDir();
  const ids = existsSync(dir) ? readdirSync(dir) : [];
  const rooms: Record<string, unknown>[] = [];
  // 読み取れないルームは一覧から落ちる。件数に出さないと、
  // 壊れていること自体がどこにも現れなくなる。
  const unreadable: string[] = [];
  for (const id of ids) {
    const room = safeReadRoom(id);
    if (!room) {
      unreadable.push(id);
      continue;
    }
    const seq = latestSeq(room.id);
    rooms.push({
      room_id: room.id,
      topic: room.topic,
      status: room.status,
      turn: turnOf(room, seq),
      hops_left: hopsLeftOf(room, seq),
      unread: unreadOf(room),
      last_activity_at: room.last_activity_at,
      log_path: logPath(room.id),
    });
  }
  const guide =
    rooms.length === 0
      ? "ルームはありません。会話を始めるなら open を、参加するなら room_id をユーザーに確認してください。"
      : `${rooms.length} 件のルームがあります。どのルームの話かをユーザーに確認してください。` +
        `未読があるルームは join で続きを読めます。`;
  emit({
    ok: true,
    rooms,
    unreadable,
    next: "ask_user",
    hint:
      unreadable.length > 0
        ? `${guide}${unreadable.join(" と ")} は状態を読み取れません。` +
          `room.json をユーザーに確認してもらってください。`
        : guide,
  });
};

/**
 * 用があれば 0、無ければ 1、状態を読めなければ 2 を返す。
 * 読めないファイルで恒久的に block されると復帰できないため、異常は安全側に倒す。
 */
const cmdCheck = (flags: Flags): void => {
  const as = selfName(flags);
  if (!isValidName(as)) {
    process.exitCode = 2;
    return;
  }
  const only = flags.room;
  try {
    const dir = roomsDir();
    const ids = existsSync(dir) ? readdirSync(dir) : [];
    const lines: string[] = [];
    for (const id of ids) {
      if (only !== undefined && id !== only) continue;
      const room = safeReadRoom(id);
      if (!room) continue;
      sweepIdle(room);
      const participant = room.participants[as];
      if (!participant) continue;
      const seq = latestSeq(id);
      if (turnOf(room, seq) !== as) continue;
      const unread = seq - participant.last_read;
      if (unread <= 0) continue;
      const files = messageFiles(id);
      const from = senderOfFile(files[files.length - 1]);
      // 閉じたルームに残りの往復はない。中断を判断する材料として読まれるため、
      // 続けられる会話と同じ表示にしない。
      const remaining =
        room.status === "closed" ? "閉じています" : `残り${hopsLeftOf(room, seq)}往復`;
      lines.push(`${id}: ${from} から ${unread} 件（${remaining}）— ${room.topic}`);
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

const { command, positional, flags, error } = parseArgv(process.argv.slice(2));

if (error !== undefined) {
  // check は終了コードで答える設計なので、値の欠落も安全側の 2 に倒す。
  if (command === "check") process.exitCode = 2;
  else invalidArgument(error);
} else {
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
        next: "retry",
        hint:
          (command === ""
            ? "コマンドが指定されていません。"
            : `${command} は未対応のコマンドです。`) +
          `使えるのは ${COMMANDS.join(" / ")} です。`,
      });
  }
}

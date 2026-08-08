import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";

type Next = "say" | "receive" | "report" | "ask_user" | "retry";
type RoomStatus = "open" | "closed";

/** 書ける理由と受け入れる理由を 1 箇所で決める。分けると自分が書いた値を読めなくなる。 */
const CLOSED_REASONS = ["hop_limit", "stale", "no_response", "idle", "manual"] as const;
type ClosedReason = (typeof CLOSED_REASONS)[number];

const isClosedReason = (value: unknown): value is ClosedReason =>
  (CLOSED_REASONS as readonly unknown[]).includes(value);

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

/**
 * 通し番号をファイル名に綴る桁数。桁を超えると並び順も番号も発言者も変わるため、
 * 往復の上限はこの桁に収まる範囲で決める。1 往復で 2 件書く。
 */
const SEQ_DIGITS = 4;
const MAX_SEQ = 10 ** SEQ_DIGITS - 1;
const MAX_HOPS = Math.floor(MAX_SEQ / 2);

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

/** 呼び出し側は標準出力を 1 行の JSON として読む。2 行目を出さないために覚えておく。 */
let emitted = false;

const emit = (payload: Record<string, unknown>): void => {
  console.log(JSON.stringify(payload));
  emitted = true;
};

/**
 * 状態ファイルの値が使えないことを表す。
 * 読み込みでは解析器の投げるものも通るため、印を付けて自分の文だけを人へ渡す。
 */
const INVALID_STATE = "invalidState";

const invalidState = (message: string): Error =>
  Object.assign(new Error(message), { [INVALID_STATE]: true });

/**
 * 発言のファイルが使えないことを表す。room.json とは別に持つのは、
 * 開いて直す先が違うためである。どのファイルかを言えないと、人は room.json を見に行く。
 */
const INVALID_MESSAGE = "invalidMessage";

const invalidMessage = (id: string, message: string): Error =>
  Object.assign(new Error(message), { [INVALID_MESSAGE]: true, roomId: id });

/**
 * 書き込めないことを表す。値が読めない場合と分けるのは、
 * 人に確かめてほしいものが中身ではなく置き場所と権限だからである。
 */
const UNWRITABLE = "unwritable";

/** 書き込みの失敗にどこへ書こうとしたかを添える。失敗しても投げるものを 1 種類に保つ。 */
const writing = <T>(path: string, write: () => T): T => {
  try {
    return write();
  } catch (cause) {
    throw Object.assign(new Error(path), { [UNWRITABLE]: true, cause });
  }
};

/** 欠けていれば 0 として読む。書かれていて 0 以上の整数でなければ断る。 */
const countOf = (value: unknown, label: string): number => {
  if (value === undefined) return 0;
  if (!Number.isInteger(value) || (value as number) < 0) {
    throw invalidState(`${label} が 0 以上の整数ではありません。キーごと消せば 0 として読みます。`);
  }
  return value as number;
};

/**
 * 状態ファイルを読む。人間が書き換える手順を案内している以上、使える形かをここで確かめる。
 *
 * 欠けていて安全な既定があるものは寄せ、無いものと解釈できない値は断る。
 * 寄せてよいのは、結果が「まだ読んでいない」「まだ数えていない」に倒れるものだけ。
 * 上限や先手をこちらで決めると、歯止めや発言権が黙って変わる。
 */
const readRoom = (id: string): Room | null => {
  const path = roomJsonPath(id);
  if (!existsSync(path)) return null;
  const room = JSON.parse(readFileSync(path, "utf8")) as Room;
  if (room.id !== id) {
    throw invalidState("id がディレクトリ名と一致しません。");
  }
  if (room.status !== "open" && room.status !== "closed") {
    throw invalidState("status が open でも closed でもありません。");
  }
  // 閉じた理由は報告にそのまま乗る。開閉と食い違うと、閉じた会話が理由なしで報告される。
  if (room.status === "closed") {
    if (!isClosedReason(room.closed_reason)) {
      throw invalidState(
        `閉じたルームの closed_reason が ${CLOSED_REASONS.join(" / ")} のいずれでもありません。`,
      );
    }
  } else if (room.closed_reason !== null) {
    throw invalidState("開いたルームに closed_reason があります。");
  }
  // 人が書き換える唯一の手段がここなので、開くときと同じ範囲で受ける。
  if (!Number.isInteger(room.max_hops) || room.max_hops < 1 || room.max_hops > MAX_HOPS) {
    throw invalidState(`max_hops が 1 以上 ${MAX_HOPS} 以下の整数ではありません。`);
  }
  // 日時として読めないと無音の長さが数えられず、掃除が効かないまま開いたルームが残る。
  // 日時は文字列で持つ。数値や真偽値も Date は受けるが、どれも 1970 になり掃除が即座に効く。
  if (
    typeof room.last_activity_at !== "string" ||
    Number.isNaN(new Date(room.last_activity_at).getTime())
  ) {
    throw invalidState("last_activity_at が日時として読み取れません。");
  }
  // 先の時刻だと無音の長さが負になり、掃除が永久に効かない。書き込むのは常に今なので、
  // 先を指しているのは手で書き換えたか時計が戻ったかで、どちらも人が直す。
  if (new Date(room.last_activity_at).getTime() > Date.now()) {
    throw invalidState("last_activity_at が先の時刻を指しています。");
  }
  if (
    typeof room.participants !== "object" ||
    room.participants === null ||
    Array.isArray(room.participants)
  ) {
    throw invalidState("participants がありません。");
  }
  // 先手は participants の中から選ばれる。外れていると双方の番が来ない。
  if (typeof room.opener !== "string" || !(room.opener in room.participants)) {
    throw invalidState("opener が参加者の名前ではありません。");
  }
  room.stale_streak = countOf(room.stale_streak, "stale_streak");
  for (const [name, participant] of Object.entries(room.participants)) {
    if (typeof participant !== "object" || participant === null) {
      throw invalidState(`${name} の状態が読み取れません。`);
    }
    participant.last_read = countOf(participant.last_read, `${name} の last_read`);
    participant.timeouts = countOf(participant.timeouts, `${name} の timeouts`);
    participant.join_timeouts = countOf(participant.join_timeouts, `${name} の join_timeouts`);
  }
  // 発言権と往復数は通し番号から導く。番号が詰まっていることは設計が既に仮定しているので、
  // ここで確かめる。穴の前後どちらが本来の並びかは決められないため、数え直しはしない。
  messageFiles(id).forEach((file, index) => {
    const seq = seqOfFile(file);
    if (seq !== index + 1) {
      throw invalidMessage(id, `発言の通し番号が ${index + 1} ではなく ${seq} から続いています。`);
    }
  });
  return room;
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
  const path = roomJsonPath(room.id);
  writing(path, () => writeFileSync(path, `${JSON.stringify(room, null, 2)}\n`, "utf8"));
};

const newParticipant = (): Participant => ({ last_read: 0, timeouts: 0, join_timeouts: 0 });

/**
 * 発言のファイル名。通し番号と発言者をここから取り出し、発言権も往復数もそれに従うため、
 * 形の合わないものを数えると会話の状態が変わる。room.json より重い状態がここにある。
 */
const MESSAGE_FILE = new RegExp(`^(\\d{${SEQ_DIGITS}})-(.+)\\.md$`);

const isMessageFile = (file: string): boolean => {
  const match = MESSAGE_FILE.exec(file);
  return match !== null && isValidName(match[2]);
};

const entriesOf = (id: string): string[] => {
  const dir = messagesDir(id);
  return existsSync(dir) ? readdirSync(dir) : [];
};

const messageFiles = (id: string): string[] => entriesOf(id).filter(isMessageFile).sort();

/** 発言として数えなかったもの。黙って落とすと、発言が消えたようにしか見えない。 */
const ignoredFiles = (id: string): string[] => entriesOf(id).filter((f) => !isMessageFile(f));

/** 数えなかったことを伝える窓。発言が誤って落ちたときに気づける経路はここだけになる。 */
const ignoredHint = (ignored: string[]): string =>
  ignored.length === 0
    ? ""
    : `発言として数えなかったファイルが ${ignored.length} 件あります（${ignored.join(" / ")}）。` +
      `本来の発言であればユーザーに知らせてください。`;

const seqOfFile = (file: string): number => Number(file.slice(0, SEQ_DIGITS));

/** 名前はファイル名を経由して戻る。保存した綴りを変える環境があるため、比べる側でも寄せる。 */
const senderOfFile = (file: string): string =>
  file.slice(SEQ_DIGITS + 1, -3).normalize("NFC");

const latestSeq = (id: string): number => {
  const files = messageFiles(id);
  return files.length === 0 ? 0 : seqOfFile(files[files.length - 1]);
};

/**
 * まだ読んでいない相手の発言。自分の発言は含めない。
 * 発言を書いてから状態を書くまでの間に落ちると自分の発言が未読として残り、
 * そのまま渡せば自分の書いたものを相手の見解として読ませることになる。
 * 読む側も数える側もここを通す。同じ条件が各所に散ると、片方だけが直る。
 */
const unreadFiles = (id: string, after: number, as: string): string[] =>
  messageFiles(id).filter((file) => seqOfFile(file) > after && senderOfFile(file) !== as);

const readMessages = (id: string, after: number, as: string): Message[] =>
  unreadFiles(id, after, as).map((file) => {
    const raw = readFileSync(join(messagesDir(id), file), "utf8");
    const headEnd = raw.indexOf("\n---\n");
    // ヘッダが無いと日時も本文も別の位置から切り出され、
    // 参加者の名前で、その人が書いていない発言として返ることになる。
    if (!raw.startsWith("---\nat: ") || headEnd < 0) {
      throw invalidMessage(id, `${file} が発言の形をしていません。`);
    }
    const body = raw.slice(headEnd + 5);
    return {
      seq: seqOfFile(file),
      from: senderOfFile(file),
      at: raw.slice(raw.indexOf("at: ") + 4, headEnd),
      text: body.endsWith("\n") ? body.slice(0, -1) : body,
    };
  });

const writeMessage = (id: string, seq: number, from: string, text: string): void => {
  const path = join(messagesDir(id), `${String(seq).padStart(SEQ_DIGITS, "0")}-${from}.md`);
  writing(path, () => writeFileSync(path, `---\nat: ${nowIso()}\n---\n${text}\n`, "utf8"));
};

/**
 * 名乗り。同じ字面でも合成済みと分解済みで別の文字列になるため、入口で一つに寄せる。
 * 寄せないと、見た目の同じ名前が別人として断られる。
 */
const selfName = (flags: Flags): string =>
  (flags.as ?? basename(process.cwd())).normalize("NFC");

const hopsOf = (seq: number): number => Math.ceil(seq / 2);

/**
 * 2 人揃っているか。発言も待機も、揃うまでは意味を持たない。
 * 同じ数え方が各所に散ると、参加者の扱いを変えるときに探し歩くことになる。
 */
const bothJoined = (room: Room): boolean =>
  Object.keys(room.participants).length >= MAX_PARTICIPANTS;

/**
 * 発言権は seq から導く。先手が偶数番、後手が奇数番を受け持つ。
 * 状態として持つと、発言の記録と発言権の受け渡しが別々の書き込みになり、
 * 間で落ちたときに誰も発言できないルームが残る。
 */
const turnOf = (room: Room, seq: number): string => {
  const opener = room.opener;
  if (seq % 2 === 0) return opener;
  return Object.keys(room.participants).find((name) => name !== opener) ?? opener;
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

/**
 * 状態から次の行動を決める。相手がいないルームでは say が断られるため示さない。
 * 同じ状態を説明する join と status で共有する。
 */
const nextOf = (room: Room, as: string, seq: number): Next =>
  room.status === "closed"
    ? "report"
    : bothJoined(room) && turnOf(room, seq) === as
      ? "say"
      : "receive";

/** 1 以上 limit 以下の整数だけを受ける。不正なら null を返し、呼び出し側で断る。 */
const positiveInt = (
  raw: string | undefined,
  fallback: number,
  limit = Number.MAX_SAFE_INTEGER,
): number | null => {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 && value <= limit ? value : null;
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
  // 既に閉じているルームの理由は残す。後から閉じにきた側の理由で上書きすると、
  // 話し切った会話に応答が無かったという記録が付く。
  if (room.status === "closed") return;
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

/** 参加していない名前への案内。断るコマンドと状態だけ返すコマンドで共有する。 */
const notAParticipantHint = (as: string, room: Room): string => {
  const participants = Object.keys(room.participants);
  return (
    `${as} はこのルームに参加していません。会話の読み書きは参加者に限られます。` +
    `参加しているのは ${participants.join(" と ")} です。` +
    (bothJoined(room)
      ? `このどちらかとして続けるつもりなら --as にその名前を指定してください。` +
        `2 人が埋まっているため、別の名前では join できません。`
      : // join を勧めない。room_id を取り違えていた場合、無関係のルームへ
        // 2 人目として入り、本来の相手を room_full で締め出すことになる。
        `名乗り分けをしているなら --as にその名前を指定してください。` +
        `そうでなければ room_id を取り違えている可能性があります。ユーザーに確認してください。`)
  );
};

const notAParticipantReply = (id: string, as: string, room: Room): Record<string, unknown> => ({
  ok: false,
  error: "not_a_participant",
  room_id: id,
  participants: Object.keys(room.participants),
  next: "ask_user",
  hint: notAParticipantHint(as, room),
});

const notAParticipant = (id: string, as: string, room: Room): void => {
  emit(notAParticipantReply(id, as, room));
};

/**
 * 読めない理由。自分で投げたものだけを人へ渡す。
 * 型は誰が投げたかの代わりにならない。読み込みでは解析器も実行時エラーも同じ経路を通り、
 * どちらも英語のまま hint に乗ってしまう。
 */
const reasonOf = (error: unknown): string => {
  if (error instanceof Error && Object.hasOwn(error, INVALID_MESSAGE)) {
    return error.message;
  }
  if (error instanceof Error && Object.hasOwn(error, INVALID_STATE)) {
    return `room.json の ${error.message}`;
  }
  if (error instanceof SyntaxError) return "room.json を JSON として読み取れません。";
  return "room.json を読み取れません。";
};

const corruptRoom = (id: string, reason: string): void => {
  emit({
    ok: false,
    error: "corrupt_room",
    room_id: id,
    log_path: logPath(id),
    next: "ask_user",
    hint:
      `ルーム ${id} の状態を読み取れません。${reason}` +
      `${logPath(id)} をユーザーに確認してもらってください。`,
  });
};

/** ルームを読む。読めなければ理由に応じた応答を返して null を返す。 */
const loadRoom = (id: string): Room | null => {
  try {
    const room = readRoom(id);
    if (!room) notFound(id);
    return room;
  } catch (error) {
    corruptRoom(id, reasonOf(error));
    return null;
  }
};

const CLOSING_HINT =
  "合意できた点・未解決の点・持ち帰る宿題を要約してユーザーに報告してください。" +
  "ここで出た結論は提案であり、実装はユーザーの承認を経てください。";

/** 会話を終えて報告に移らせる hint。原文の場所を必ず添える。 */
const reportHint = (id: string, head: string): string =>
  `${head}${CLOSING_HINT}原文は ${logPath(id)} に残っています。報告にこの場所を添えてください。`;

/**
 * 閉じたルームに残った未読を返し、既読にする。
 * 報告へ移る経路は複数あり、一部だけが未読を渡す形だと、
 * 受け取らなかった側は未読が無いものとして相手の最終見解を読まずに要約する。
 *
 * 見せるものと既読の位置は別の量として扱う。自分の発言しか残っていない場合、
 * 返すものは無いが位置は進める。進めないと消えない未読として残り続ける。
 */
const drainUnread = (room: Room, participant: Participant, as: string): Message[] => {
  const latest = latestSeq(room.id);
  const messages = readMessages(room.id, participant.last_read, as);
  if (latest > participant.last_read) {
    participant.last_read = latest;
    writeRoom(room);
  }
  return messages;
};

/** 閉じたルームの報告を促す hint。未読があれば読ませてから要約させる。 */
const closedHint = (id: string, unread: number, head = "ルームは閉じています。"): string =>
  reportHint(
    id,
    unread > 0
      ? `${head}未読が ${unread} 件あります。相手の最後の見解を読んでから要約してください。`
      : head,
  );

/** 待っている相手に閉室を伝える応答。理由は room から読む。 */
const closedReply = (
  room: Room,
  participant: Participant,
  as: string,
): Record<string, unknown> => {
  const messages = drainUnread(room, participant, as);
  return {
    ok: true,
    status: "closed",
    room_id: room.id,
    closed_reason: room.closed_reason,
    messages,
    log_path: logPath(room.id),
    next: "report",
    hint: closedHint(room.id, messages.length),
  };
};

const cmdOpen = (flags: Flags): void => {
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const topic = flags.topic;
  if (topic === undefined) {
    invalidArgument("--topic は必須です。この会話で詰める論点を一つ渡してください。");
    return;
  }
  const maxHops = positiveInt(flags["max-hops"], DEFAULT_MAX_HOPS, MAX_HOPS);
  if (maxHops === null) {
    invalidArgument(`--max-hops には 1 以上 ${MAX_HOPS} 以下の整数を指定してください。`);
    return;
  }
  const id = newRoomId();
  writing(messagesDir(id), () => mkdirSync(messagesDir(id), { recursive: true }));
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
): string => {
  if (room.status === "closed") return closedHint(room.id, unread, "このルームは閉じています。");
  const head = `未読 ${unread} 件。${rejoined ? "再入場です。" : "参加しました。"}`;
  if (!bothJoined(room)) {
    return `${head}相手はまだ参加していません。receive を呼べば参加を待てます。`;
  }
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
  if (!rejoined && bothJoined(room)) {
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
  // 既読の位置は、返した内容より古い側へ倒す。2 回の readdir の間に相手が発言すると、
  // 逆の順序では返さないまま既読になり、その発言はどのコマンドでも読めなくなる。
  const seq = latestSeq(id);
  const messages = readMessages(id, room.participants[as].last_read, as);
  room.participants[as].last_read = seq;
  if (room.status === "open") room.last_activity_at = nowIso();
  writeRoom(room);
  const turn = turnOf(room, seq);
  const next = nextOf(room, as, seq);
  const ignored = ignoredFiles(id);
  emit({
    ok: true,
    room_id: id,
    as,
    rejoined,
    ignored,
    topic: room.topic,
    status: room.status,
    hops_left: hopsLeftOf(room, seq),
    messages,
    turn,
    log_path: logPath(id),
    next,
    hint: joinHint(room, seq, messages.length, rejoined, next) + ignoredHint(ignored),
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
    notAParticipant(id, as, room);
    return;
  }
  if (room.status === "closed") {
    const messages = drainUnread(room, room.participants[as], as);
    emit({
      ok: false,
      error: "closed",
      room_id: id,
      status: "closed",
      closed_reason: room.closed_reason,
      messages,
      log_path: logPath(id),
      next: "report",
      hint: closedHint(id, messages.length, "このルームは閉じています。"),
    });
    return;
  }
  if (!bothJoined(room)) {
    emit({
      ok: false,
      error: "alone_in_room",
      room_id: id,
      participants: Object.keys(room.participants),
      // 相手を待てば解決する。人間を呼ぶと、席を外している間は会話が止まる。
      next: "receive",
      hint:
        "このルームにはまだ自分しかいません。相手が参加するまで発言できません。" +
        "receive を呼べば参加を待てます。待っても来ない場合は、" +
        "--as の付け忘れで相手と同じ名前になっていないかを確かめてください。",
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
  // 発言の前に未読を控える。last_read を自分の発言番号へ進めるため、
  // 先に取らないと読んでいない相手の発言まで既読になり、あとから読む手段が残らない。
  // 発言権は seq から導けるので、相手の発言を受け取らないまま say できる。
  const unread = readMessages(id, room.participants[as].last_read, as);
  writeMessage(id, seq, as, text);
  room.stale_streak = advanced === "true" ? 0 : room.stale_streak + 1;
  room.participants[as].last_read = seq;
  room.last_activity_at = nowIso();
  const hopsLeft = hopsLeftOf(room, seq);

  // 上限は予告と同じ関数で判定する。式を分けると、予告なく閉じたり、
  // 最後ではない発言に最後だと告げたりする形で静かにずれる。
  const reason: ClosedReason | null = isFinalTurn(room, current)
    ? "hop_limit"
    : room.stale_streak >= 2
      ? "stale"
      : null;

  if (reason) {
    closeRoom(room, reason);
    emit({
      ok: true,
      room_id: id,
      seq,
      hops_left: hopsLeft,
      status: "closed",
      closed_reason: reason,
      messages: unread,
      log_path: logPath(id),
      next: "report",
      hint: closedHint(
        id,
        unread.length,
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
  const participant = room.participants[as];
  // 入口で確かめた後に呼ばれる。それでも欠けていたときに黙って待つと、
  // 待機の上限まで進んだ末に、応答が無かったという記録だけが残る。
  if (!participant) return notAParticipantReply(id, as, room);
  const seq = latestSeq(id);

  if (room.status === "closed") return closedReply(room, participant, as);

  const seen = participant.last_read;
  if (seq > seen) {
    const messages = readMessages(id, seen, as);
    participant.last_read = seq;
    // 相手の応答が届いた時点で待ち直しになる。時間切れは往復のたびに起きるため、
    // 数え続けると応答している相手との会話が打ち切られる。
    if (messages.length > 0) participant.timeouts = 0;
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
  if (!bothJoined(room)) return null;

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
    notAParticipant(id, as, opening);
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
    notAParticipant(id, as, room);
    return;
  }

  // 待つ間に閉じられていることがある。ここで見るのは、これから閉じにいく room そのもの。
  // 別に読んだ状態で判定すると、他人が閉じた理由を上書きしたうえで、
  // 応答が無かったという記録に変えることになる。
  if (room.status === "closed") {
    emit(closedReply(room, participant, as));
    return;
  }

  // 参加を待っている間の時間切れは、会話中の長考とは別に数える。
  const awaitingJoin = !bothJoined(room);
  if (awaitingJoin) participant.join_timeouts += 1;
  else participant.timeouts += 1;
  writeRoom(room);
  const retriesLeft = RETRY_LIMIT - (awaitingJoin ? participant.join_timeouts : participant.timeouts);

  if (retriesLeft <= 0) {
    closeRoom(room, "no_response");
    emit({
      ok: true,
      status: "closed",
      room_id: id,
      closed_reason: room.closed_reason,
      log_path: logPath(id),
      next: "report",
      // 相手が一度も参加していなければ発言も無い。起きていない会話に要約を求めない。
      hint: awaitingJoin
        ? "待機の上限に達したためルームを閉じました。相手はまだ参加しておらず、発言もありません。" +
          "要約するものはないので、room_id が正しく伝わったかをユーザーに確かめてください。" +
          "room_id が伝わっていないか、--as の付け忘れで相手と同じ名前になっている可能性があります。"
        : reportHint(
            id,
            "待機の上限に達したためルームを閉じました。相手が停止したのか、まだ考えているのかは区別できません。" +
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
  const unread: Record<string, number> = {};
  for (const name of Object.keys(room.participants)) {
    unread[name] = unreadFiles(room.id, room.participants[name].last_read, name).length;
  }
  return unread;
};

/** 状態を説明する hint。参加していない名前に会話の指示を渡さない。 */
const statusHint = (room: Room, as: string, seq: number, next: Next, unread: number): string => {
  if (!(as in room.participants)) return notAParticipantHint(as, room);
  if (room.status === "closed") {
    // 既読にしないコマンドなので、読む手段を添える。
    return reportHint(
      room.id,
      unread > 0
        ? `このルームは閉じています。未読が ${unread} 件あります。` +
            `receive で読んでから要約してください。`
        : "このルームは閉じています。",
    );
  }
  if (!bothJoined(room)) return "相手はまだ参加していません。receive を呼べば参加を待てます。";
  const standing =
    `発言権は ${turnOf(room, seq)} にあります。残り ${hopsLeftOf(room, seq)} 往復です。`;
  return next === "say" ? sayHint(room, seq, standing) : standing;
};

/** 既読にしない。確認しただけで last_read が進むと、未読を取りこぼす。 */
const cmdStatus = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const room = loadRoom(id);
  if (!room) return;
  sweepIdle(room);
  const seq = latestSeq(id);
  const unread = unreadOf(room);
  const ignored = ignoredFiles(id);
  // 参加していない名前に say や receive を促すと、その次で断られる。
  const next: Next = as in room.participants ? nextOf(room, as, seq) : "ask_user";
  emit({
    ok: true,
    room_id: id,
    status: room.status,
    topic: room.topic,
    turn: turnOf(room, seq),
    hops_left: hopsLeftOf(room, seq),
    unread,
    ignored,
    participants: Object.keys(room.participants),
    last_activity_at: room.last_activity_at,
    log_path: logPath(id),
    next,
    hint: statusHint(room, as, seq, next, unread[as] ?? 0) + ignoredHint(ignored),
  });
};

const cmdClose = (positional: string[], flags: Flags): void => {
  const id = positional[0] ?? "";
  if (rejectMissingRoom(id)) return;
  const as = selfName(flags);
  if (rejectInvalidName(as)) return;
  const room = loadRoom(id);
  if (!room) return;
  sweepIdle(room);
  if (!(as in room.participants)) {
    notAParticipant(id, as, room);
    return;
  }
  const reason = flags.reason ?? "manual";
  if (!isClosedReason(reason)) {
    invalidArgument(
      `--reason には ${CLOSED_REASONS.join(" / ")} のいずれかを指定してください。` +
        `${reason} は解釈できません。`,
      id,
    );
    return;
  }
  const alreadyClosed = room.status === "closed";
  closeRoom(room, reason);
  const messages = drainUnread(room, room.participants[as], as);
  emit({
    ok: true,
    room_id: id,
    closed_reason: room.closed_reason,
    hops_used: hopsOf(latestSeq(id)),
    messages,
    log_path: logPath(id),
    next: "report",
    hint: closedHint(
      id,
      messages.length,
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
    sweepIdle(room);
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
      const files = unreadFiles(id, participant.last_read, as);
      if (files.length === 0) continue;
      const from = senderOfFile(files[files.length - 1]);
      // 閉じたルームに残りの往復はない。中断を判断する材料として読まれるため、
      // 続けられる会話と同じ表示にしない。
      const remaining =
        room.status === "closed" ? "閉じています" : `残り${hopsLeftOf(room, seq)}往復`;
      lines.push(`${id}: ${from} から ${files.length} 件（${remaining}）— ${room.topic}`);
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

/**
 * 標準出力に JSON を 1 行返して 0 で終わることは、個々の操作の性質ではなく
 * 呼び出し側との約束である。操作ごとに囲むと、次に足した操作が同じ穴を開ける。
 * 入口で受けて、どの経路から投げても約束の側を保つ。
 */
const failed = (thrown: unknown): void => {
  // check は自身の中でも受けている。ここへ来るのは引数の解釈で投げた場合だけで、
  // 終了コードで答える設計に合わせ、JSON を足さず安全側の 2 に倒す。
  if (command === "check") {
    process.exitCode = 2;
    return;
  }
  // 既に返した後で投げた場合、2 行目を足すと呼び出し側の読み取りが壊れる。
  // 握り潰さずに済ませるため、標準エラーへ 1 行だけ残す。
  if (emitted) {
    console.error(`cxtalk: 応答を返した後に失敗しました: ${messageOf(thrown)}`);
    return;
  }
  // 発言のファイルは読む直前まで開かれないため、ここまで届く。
  // 読めない理由の伝え方は room.json のときと同じ枠に載せる。
  if (thrown instanceof Error && Object.hasOwn(thrown, INVALID_MESSAGE)) {
    corruptRoom((thrown as Error & { roomId: string }).roomId, reasonOf(thrown));
    return;
  }
  if (thrown instanceof Error && Object.hasOwn(thrown, UNWRITABLE)) {
    emit({
      ok: false,
      error: UNWRITABLE,
      next: "ask_user",
      hint:
        `${thrown.message} に書き込めません。` +
        `置き場所があるか、書き込む権限があるかをユーザーに確認してもらってください。`,
    });
    return;
  }
  emit({
    ok: false,
    error: "unexpected_failure",
    next: "ask_user",
    hint: `予期しない失敗です。${messageOf(thrown)} をそのままユーザーに伝えてください。`,
  });
};

const messageOf = (thrown: unknown): string =>
  thrown instanceof Error ? thrown.message : String(thrown);

/**
 * 相対パスは作業ディレクトリを基準に解決されるため、同じ設定でも呼ぶ場所で置き場が変わる。
 * 寄せ先を決めても呼ぶ側の期待と食い違ったときに気づけないので、断る。
 */
const rejectRelativeHome = (): boolean => {
  const home = process.env.CXTALK_HOME;
  if (home === undefined || isAbsolute(home)) return false;
  if (command === "check") {
    process.exitCode = 2;
    return true;
  }
  emit({
    ok: false,
    error: "invalid_home",
    next: "ask_user",
    hint:
      `CXTALK_HOME に相対パス ${home} が設定されています。` +
      `呼ぶ場所によって置き場が変わり、開いたルームが見つからなくなります。` +
      `絶対パスに直すようユーザーに伝えてください。`,
  });
  return true;
};

// 引数の解釈も入口の内側に置く。手前に何かを残すと、そこだけ約束の外になる。
let command = "";

try {
  const parsed = parseArgv(process.argv.slice(2));
  const { positional, flags, error } = parsed;
  command = parsed.command;

  if (rejectRelativeHome()) {
    // 置き場が決まらなければ、どのコマンドも意味のある答えを返せない。
  } else if (error !== undefined) {
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
} catch (thrown) {
  failed(thrown);
}

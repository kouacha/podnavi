"use strict";

// ===== 初期値（ここを書き換えると初期表示が変わります） =====
const DEFAULTS = { from: "熊本駅", to: "熊本城", mode: "pedestrian", genre: "none" };
const WINDOWS_SEC = [180, 300, 600, null]; // 前後3分→5分→10分→制限なし
const WINDOW_LABELS = ["前後3分以内", "前後5分以内", "前後10分以内", "時間制限なし（近い順）"];
const MIN_RESULT_COUNT = 10; // 最低でもこの件数を目指す（固定ではない）
const INITIAL_RESULT_COUNT = 10; // 検索直後に表示する件数
const SIDE_MIN_COUNT = 3;        // 一般キーワード検索で、移動時間より短い側・長い側それぞれ最低これだけ集める
const LOAD_MORE_COUNT = 10;      // 「もっと見る」1回で追加する件数
let allMatchedEpisodes = [];     // 検証・重複除外・並べ替え済みの全候補
let visibleEpisodeCount = 0;     // 現在表示している件数
const GENERIC_KEYWORDS_BY_TYPE = { // ジャンル「無し」用の一般キーワード（コンテンツ種別ごと）
  podcast: ["ラジオ", "ポッドキャスト", "トーク", "ニュース", "お笑い", "ビジネス", "教育", "文化", "科学", "歴史"],
  music: ["J-POP", "ポップ", "ロック", "アニメ", "ジャズ", "クラシック", "ヒップホップ", "ダンス", "R&B", "サウンドトラック"],
};
const GENRES_BY_TYPE = { // コンテンツ種別ごとのジャンル選択肢 [value, 表示名]
  podcast: [["none", "無し"], ["お笑い"], ["ニュース"], ["ビジネス"], ["テクノロジー"], ["教育"], ["カルチャー"], ["歴史"], ["科学"]],
  music: [["none", "無し"], ["J-POP"], ["ロック"], ["ポップ"], ["アニメ"], ["ヒップホップ"], ["ジャズ"], ["クラシック"], ["ダンス"], ["R&B"], ["サウンドトラック"]],
};
const CONTENT_NAMES = { podcast: "ポッドキャスト", music: "音楽" };
let currentContentType = "podcast"; // 結果カードの種類の切り替えに使う
const JSONP_TIMEOUT_MS = 10000;
const MODE_NAMES = { pedestrian: "徒歩", bicycle: "自転車", auto: "自動車" };

// ユーザー向けメッセージ付きの独自エラー
class AppError extends Error {
  constructor(userMessage, detail) { super(detail || userMessage); this.userMessage = userMessage; }
}

const $ = (id) => document.getElementById(id);
const els = {
  form: $("search-form"), from: $("from-input"), to: $("to-input"), mode: $("mode-select"),
  genre: $("genre-select"), free: $("free-input"), manualCheck: $("manual-check"),
  manualFields: $("manual-fields"), hours: $("manual-hours"), minutes: $("manual-minutes"),
  button: $("submit-button"), error: $("error-area"), progress: $("progress"),
  summary: $("summary"), summaryTitle: $("summary-title"), summaryList: $("summary-list"), results: $("results"),
  modeMapBtn: $("input-map-btn"), modeNameBtn: $("input-name-btn"), nameFields: $("name-fields"),
  searchFrom: $("search-from-btn"), searchTo: $("search-to-btn"), status: $("map-status"),
  btnPickStart: $("pick-start-btn"), btnPickEnd: $("pick-end-btn"), btnLocate: $("locate-btn"),
  content: $("content-select"), btnSwap: $("swap-btn"), btnReset: $("reset-btn"), candidates: $("candidates"), pointsView: $("points-view"), moreWrap: $("more-wrap"), moreBtn: $("more-btn"),
};

// ===== 表示用ユーティリティ =====
// 秒 → 「45秒」「5分20秒」「1時間12分05秒」
function formatDuration(totalSeconds) {
  const s = Math.round(Math.abs(totalSeconds));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  if (h > 0) return `${h}時間${m}分${String(sec).padStart(2, "0")}秒`;
  if (m > 0) return `${m}分${sec}秒`;
  return `${sec}秒`;
}
// 時間差（秒, 正=到着より長い）を文章にする
function describeDifference(diffSec) {
  const d = Math.round(diffSec);
  if (d === 0) return "到着と同時に終了";
  return d < 0 ? `到着より${formatDuration(d)}早く終了` : `到着後${formatDuration(d)}で終了`;
}
function formatDateJa(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "公開日不明";
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日`;
}
// ぴったり度：100 - 絶対差秒 ÷ max(5, 移動時間秒 ÷ 150)（0〜100に丸める）
function calcMatchScore(absDiffSec, travelSec) {
  const n = Math.max(5, travelSec / 150);
  const score = Math.round(100 - absDiffSec / n);
  return Math.min(100, Math.max(0, score));
}

// ===== 画面状態 =====
function showError(message) { els.error.textContent = message; els.error.hidden = false; }
function clearError() { els.error.textContent = ""; els.error.hidden = true; }
function setLoading(isLoading) {
  state.loading = isLoading; updateSubmitState();
  els.button.textContent = isLoading ? "ちょうどいい一話を探しています…" : "ちょうどいい一話を探す";
}
function toggleManualFields() { els.manualFields.hidden = !els.manualCheck.checked; }
// step: 現在実行中の番号(0始まり)。それ未満は完了、-1で全て完了
function updateProgress(step, skipped = 0) {
  els.progress.hidden = false;
  [...els.progress.children].forEach((li, i) => {
    li.className = i < skipped ? "" : (step === -1 || i < step) ? "done" : i === step ? "active" : "";
  });
}

// ===== 入力検証 =====
function validateInput() {
  const from = els.from.value.trim(), to = els.to.value.trim();
  const manual = els.manualCheck.checked;
  const input = { from, to, mode: els.mode.value, manual, contentType: els.content.value === "music" ? "music" : "podcast",
    term: els.free.value.trim() || (els.genre.value === "none" ? "" : els.genre.value) }; // 空文字＝ジャンル指定なし（"none"は送らない）
  if (manual) {
    const h = Number(els.hours.value), m = Number(els.minutes.value);
    if (!Number.isInteger(h) || !Number.isInteger(m) || h < 0 || m < 0 || m > 59) throw new AppError("手動入力の時間・分が正しくありません。");
    if (h === 0 && m === 0) throw new AppError("移動時間は1分以上で入力してください。");
    input.manualSeconds = h * 3600 + m * 60;
    return input;
  }
  if (!state.start) throw new AppError("出発地点が未選択です。地図上か場所名で選んでください。");
  if (!state.end) throw new AppError("到着地点が未選択です。地図上か場所名で選んでください。");
  if (Math.abs(state.start.lat - state.end.lat) < 0.0001 && Math.abs(state.start.lon - state.end.lon) < 0.0001) throw new AppError("出発地点と到着地点が同じか近すぎます。");
  input.from = state.start.name; input.to = state.end.name;
  return input;
}

// ===== API① Nominatim（場所名検索・逆ジオコーディング）は下部の地図機能に記述 =====

// ===== API② Valhalla ルート検索 =====
async function fetchRoute(from, to, costing) {
  const body = { locations: [{ lat: from.lat, lon: from.lon }, { lat: to.lat, lon: to.lon }],
    costing, units: "kilometers", language: "ja-JP" };
  let data;
  try {
    const res = await fetch("https://valhalla1.openstreetmap.de/route?json=" + encodeURIComponent(JSON.stringify(body)));
    if (!res.ok) throw new Error("HTTP " + res.status);
    data = await res.json();
  } catch (e) { throw new AppError("ルートを取得できませんでした。公開サーバーが混雑中か、経路がない可能性があります。手動入力もお試しください。", e.message); }
  const summary = data && data.trip && data.trip.summary;
  if (!summary || typeof summary.time !== "number") throw new AppError("移動時間を取得できませんでした。");
  if (summary.time <= 0) throw new AppError("移動時間が0秒以下です。2地点が近すぎる可能性があります。");
  const leg = Array.isArray(data.trip.legs) ? data.trip.legs[0] : null;
  return { seconds: summary.time, km: typeof summary.length === "number" ? summary.length : null, shape: leg && leg.shape };
}

// ===== API③ iTunes Search（fetch → 失敗時JSONP） =====
function buildPodcastUrl(term, callbackName, contentType = "podcast") {
  const p = new URLSearchParams({ term, country: "JP", lang: "ja_jp", ...(contentType === "music" ? { media: "music", entity: "song" } : { media: "podcast", entity: "podcastEpisode" }), limit: "200" });
  if (callbackName) p.set("callback", callbackName);
  return "https://itunes.apple.com/search?" + p.toString();
}
async function searchPodcastsByFetch(term, contentType) {
  const res = await fetch(buildPodcastUrl(term, undefined, contentType));
  if (!res.ok) throw new Error("HTTP " + res.status);
  return res.json();
}
function searchPodcastsByJsonp(term, contentType) {
  return new Promise((resolve, reject) => {
    const name = "podnaviCb_" + Date.now() + "_" + Math.floor(Math.random() * 1e6); // 一意な関数名
    const script = document.createElement("script");
    let timer;
    const cleanup = () => { clearTimeout(timer); delete window[name]; script.remove(); }; // 後片付け
    window[name] = (data) => { cleanup(); resolve(data); };
    script.onerror = () => { cleanup(); reject(new AppError("検索への接続に失敗しました。", "JSONP error")); };
    timer = setTimeout(() => { cleanup(); reject(new AppError("検索がタイムアウトしました。時間をおいてお試しください。", "JSONP timeout")); }, JSONP_TIMEOUT_MS);
    script.src = buildPodcastUrl(term, name, contentType);
    document.head.appendChild(script);
  });
}
async function searchPodcasts(term, contentType = "podcast") {
  const isMusic = contentType === "music";
  let data;
  try { data = await searchPodcastsByFetch(term, contentType); }
  catch (e) { console.error("fetch failed, switching to JSONP:", e); data = await searchPodcastsByJsonp(term, contentType); }
  if (!data || !Array.isArray(data.results)) throw new AppError("検索から想定外のデータが返されました。");
  if (data.results.length === 0) throw new AppError(isMusic ? "条件に合う曲が見つかりませんでした。検索キーワードを変更してお試しください。" : "検索結果が0件でした。別のキーワードをお試しください。");
  // 再生時間が有限の正の数のものだけ残す（1曲・1エピソードごとに評価）
  let withTime = data.results.filter((e) => e && Number.isFinite(e.trackTimeMillis) && e.trackTimeMillis > 0);
  if (withTime.length === 0) throw new AppError(isMusic ? "再生時間つきの曲が見つかりませんでした。検索キーワードを変更してお試しください。" : "再生時間つきのエピソードが見つかりませんでした。別のキーワードをお試しください。");
  if (isMusic) { // 音楽はリンク先（trackViewUrl）が有効なものだけ
    withTime = withTime.filter((e) => typeof e.trackViewUrl === "string" && /^https?:\/\//.test(e.trackViewUrl));
    if (withTime.length === 0) throw new AppError("有効なリンクつきの曲が見つかりませんでした。検索キーワードを変更してお試しください。");
  }
  return withTime;
}

// ===== 重複除外（trackId → trackViewUrl → 曲名+番組名） =====
function episodeKey(e) {
  if (e.kind === "song") return "song:" + String(e.trackName || "").toLowerCase() + "|" + String(e.artistName || "").toLowerCase(); // 音楽は曲名+アーティストで重複判定
  if (e.trackId) return "id:" + e.trackId;
  if (e.trackViewUrl) return "url:" + e.trackViewUrl;
  return "name:" + (e.trackName || "") + "|" + (e.collectionName || "");
}
// side: 0=短い・長いの両方、-1=移動時間より短いものだけ、1=長いものだけ（件数を数えるだけで、絞り込みには使わない）
function countNear(episodes, travelSec, limitSec, side = 0) {
  return episodes.filter((e) => {
    const signedDifferenceSeconds = e.trackTimeMillis / 1000 - travelSec;
    return Math.abs(signedDifferenceSeconds) <= limitSec && (side === 0 || (side < 0 ? signedDifferenceSeconds < 0 : signedDifferenceSeconds > 0));
  }).length;
}
// ===== 候補集め：キーワードを順番に検索し、十分集まったら終了 =====
async function collectEpisodes(term, travelSec, contentType = "podcast") {
  const keywords = term ? [term] : [...new Set(GENERIC_KEYWORDS_BY_TYPE[contentType] || GENERIC_KEYWORDS_BY_TYPE.podcast)]; // 重複キーワードは検索しない
  const unique = new Map();
  let lastError = null;
  for (let i = 0; i < keywords.length; i++) {
    try {
      const found = await searchPodcasts(keywords[i], contentType); // trackTimeMillisなしは除外済み
      found.forEach((e) => { const k = episodeKey(e); if (!unique.has(k)) unique.set(k, e); });
    } catch (e) {
      lastError = e;
      if (keywords.length === 1) throw e;
      console.error("keyword search failed:", keywords[i], e);
    }
    // 前後10分以内の候補が最低件数に届いたら追加検索を終了
    // 短い側・長い側の両方にも一定数（SIDE_MIN_COUNT）そろうまで、追加検索を続ける
    const pool = [...unique.values()];
    if (countNear(pool, travelSec, WINDOWS_SEC[2]) >= MIN_RESULT_COUNT
      && countNear(pool, travelSec, WINDOWS_SEC[2], -1) >= SIDE_MIN_COUNT
      && countNear(pool, travelSec, WINDOWS_SEC[2], 1) >= SIDE_MIN_COUNT) break;
  }
  if (unique.size === 0) throw lastError || new AppError(contentType === "music" ? "条件に合う曲が見つかりませんでした。検索キーワードを変更してお試しください。" : "検索結果が0件でした。");
  return [...unique.values()];
}

// ===== 絞り込み：最低件数に届くまで範囲を広げる =====
function selectClosestEpisodes(episodes, travelSec) {
  const scored = episodes.map((e) => {
    const diffSec = e.trackTimeMillis / 1000 - travelSec; // ミリ秒→秒に変換して比較
    return { episode: e, diffSec, absDiff: Math.abs(diffSec), matchScore: calcMatchScore(Math.abs(diffSec), travelSec) };
  }).sort((a, b) => a.absDiff - b.absDiff
    || new Date(b.episode.releaseDate) - new Date(a.episode.releaseDate)
    || String(a.episode.trackName || "").localeCompare(String(b.episode.trackName || ""), "ja"));
  let chosen = [], rangeLabel = "";
  for (let i = 0; i < WINDOWS_SEC.length; i++) {
    const limit = WINDOWS_SEC[i];
    chosen = limit === null ? scored : scored.filter((s) => s.absDiff <= limit);
    rangeLabel = WINDOW_LABELS[i];
    if (chosen.length >= MIN_RESULT_COUNT) break; // 最低件数に届いたら拡大終了
  }
  return { items: chosen, rangeLabel, shortage: chosen.length < MIN_RESULT_COUNT };
}

// ===== 結果表示（innerHTMLは使わずcreateElement） =====
function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function renderSummary(info) {
  els.summaryTitle.textContent = info.contentType === "music" ? `${formatDuration(info.seconds)}に近い長さの曲` : `${formatDuration(info.seconds)}で聴き終わるエピソード`;
  els.summaryList.replaceChildren();
  const rows = [["出発地", info.from], ["到着地", info.to], ["移動手段", MODE_NAMES[info.mode]],
    ["移動時間", formatDuration(info.seconds) + (info.manual ? "（手動入力）" : "")],
    ["移動距離", info.km === null ? "—" : info.km.toFixed(1) + " km"],
    ["コンテンツ", CONTENT_NAMES[info.contentType]], ["検索キーワード", info.term || "ジャンル指定なし（幅広く検索）"], ["採用した検索範囲", info.rangeLabel]];
  rows.forEach(([k, v]) => { els.summaryList.append(el("dt", "", k), el("dd", "", v || "—")); });
  els.summaryList.append(el("dt", "", "表示件数"), el("dd", "count-text"));
  const old = els.summary.querySelector(".shortage"); if (old) old.remove();
  if (info.shortage) els.summary.append(el("p", "meta shortage", `条件に合う${info.contentType === "music" ? "曲" : "エピソード"}が${MIN_RESULT_COUNT}件未満だったため、見つかった${info.count}件を表示しています。`));
  els.summary.hidden = false;
}
function createCard(item) {
  const e = item.episode;
  const isMusic = currentContentType === "music";
  const card = el("article", "card");
  const head = el("div", "card-head");
  const artUrl = e.artworkUrl600 || e.artworkUrl100 || e.artworkUrl60;
  if (artUrl) {
    const img = el("img", "art"); img.src = artUrl; img.alt = ""; img.loading = "lazy";
    img.onerror = () => img.replaceWith(el("div", "art ph")); // 読込失敗時はCSSのプレースホルダー
    head.append(img);
  } else head.append(el("div", "art ph"));
  const titleBox = el("div");
  titleBox.append(el("h3", "", e.trackName || "（タイトルなし）"), el("p", "show", (isMusic ? e.artistName : e.collectionName) || ""));
  if (isMusic && e.collectionName) titleBox.append(el("p", "meta", "アルバム：" + e.collectionName));
  head.append(titleBox);
  const score = item.matchScore;
  const badge = el("div", "badge", score + "%"); badge.title = "ぴったり度";
  card.append(head, badge, el("p", "diff", describeDifference(item.diffSec)),
    el("p", "meta", `再生時間 ${formatDuration(e.trackTimeMillis / 1000)} ／ ぴったり度 ${score}%`),
    el("p", "meta", (isMusic ? "リリース日 " : "公開日 ") + formatDateJa(e.releaseDate)));
  const linkUrl = e.trackViewUrl || (isMusic ? e.collectionViewUrl : "");
  if (typeof linkUrl === "string" && /^https?:\/\//.test(linkUrl)) {
    const a = el("a", "link", isMusic ? "Apple Musicで聴く" : "Apple Podcastsで聴く");
    a.href = linkUrl; a.target = "_blank"; a.rel = "noopener noreferrer";
    card.append(a);
  }
  return card;
}
// 全候補を保存し、最初の件数だけ表示する
function renderResults(items, contentType = "podcast") {
  currentContentType = contentType; // カードの種類（ポッドキャスト/音楽）を決める
  allMatchedEpisodes = items;
  visibleEpisodeCount = 0;
  els.results.replaceChildren();
  showMoreResults(INITIAL_RESULT_COUNT);
}
// 保存済み候補から次の分だけをDOMへ追加（APIは呼ばない・既存カードは作り直さない）
function showMoreResults(count) {
  const next = Math.min(visibleEpisodeCount + count, allMatchedEpisodes.length);
  const fragment = document.createDocumentFragment();
  allMatchedEpisodes.slice(visibleEpisodeCount, next).forEach((item) => fragment.append(createCard(item)));
  els.results.append(fragment);
  visibleEpisodeCount = next;
  updateMoreButton();
  updateCountText();
}
function updateMoreButton() {
  const remaining = allMatchedEpisodes.length - visibleEpisodeCount;
  els.moreWrap.hidden = remaining <= 0;
  els.moreBtn.textContent = `もっと見る（残り${remaining}件）`;
  els.moreBtn.setAttribute("aria-label", `次の${Math.min(LOAD_MORE_COUNT, remaining)}件を表示する。残り${remaining}件`);
}
function updateCountText() {
  const node = els.summaryList.querySelector(".count-text");
  if (!node) return;
  const total = allMatchedEpisodes.length;
  node.textContent = visibleEpisodeCount >= total ? `${total}件すべて表示中` : `現在${visibleEpisodeCount}件を表示中 / 候補${total}件`;
}
// コンテンツ種別に合わせてジャンルの選択肢を入れ替える（既存のselectを再利用）
function updateGenreOptions() {
  const type = els.content.value === "music" ? "music" : "podcast";
  els.genre.replaceChildren(...GENRES_BY_TYPE[type].map(([value, label]) => {
    const opt = el("option", "", label || value); opt.value = value; return opt;
  }));
  els.genre.value = "none";
}
// 前回の結果と「もっと見る」の状態をすべて消す
function clearResults() {
  allMatchedEpisodes = []; visibleEpisodeCount = 0;
  els.results.replaceChildren();
  els.moreWrap.hidden = true;
}
function handleMoreClick() {
  els.moreBtn.disabled = true; // 処理中は無効化
  try { showMoreResults(LOAD_MORE_COUNT); }
  catch (e) { console.error(e); } // 表示済みカードは残す
  finally { els.moreBtn.disabled = false; }
}

// ===== メイン処理：API①→②→③を順番に実行 =====
async function handleSubmit(event) {
  event.preventDefault(); // ページ再読み込みを防ぐ
  clearError();
  clearRoute();
  els.summary.hidden = true;
  clearResults();
  let input;
  try { input = validateInput(); } catch (e) { showError(e.userMessage || "入力内容を確認してください。"); return; }

  setLoading(true);
  try {
    let seconds, km = null;
    if (input.manual) {
      seconds = input.manualSeconds; // 手動モードはAPI①②を使わない
      updateProgress(3, 3);
    } else {
      updateProgress(0);
      const from = { lat: state.start.lat, lon: state.start.lon }; // API①で得た座標（丸めない）
      updateProgress(1);
      const to = { lat: state.end.lat, lon: state.end.lon };
      updateProgress(2);
      const route = await fetchRoute(from, to, input.mode);    // API②：座標→移動時間
      seconds = route.seconds; km = route.km;
      drawRoute(route.shape); // 経路線の失敗は検索に影響しない
      updateProgress(3);
    }
    const episodes = await collectEpisodes(input.term, seconds, input.contentType); // API③（必要なら複数キーワード）
    updateProgress(4, input.manual ? 3 : 0);
    const { items, rangeLabel, shortage } = selectClosestEpisodes(episodes, seconds); // 移動時間で絞り込み
    updateProgress(-1, input.manual ? 3 : 0);
    renderSummary({ ...input, seconds, km, rangeLabel, count: items.length, shortage });
    renderResults(items, input.contentType);
  } catch (e) {
    console.error(e);
    showError(e.userMessage || "予期しないエラーが発生しました。もう一度お試しください。");
    els.progress.hidden = true;
  } finally {
    setLoading(false); // 成功・失敗どちらでもボタンを戻す
  }
}

// ===== 地図機能（MapLibre GL JS + OpenFreeMap Liberty） =====
const MAP_CENTER = [130.7079, 32.8031]; // [経度, 緯度]
const MAP_ZOOM = 12;
const FALLBACK_NAME = "地図上で選択した地点";
const state = { start: null, end: null, selecting: "start", loading: false, searching: false, map: null, markers: {}, mapErrorShown: false };
const searchCache = new Map();  // 場所名 → 候補
const reverseCache = new Map(); // 座標 → 地点名
const ROLE_LABEL = { start: "出発地", end: "到着地" };

// 検索ボタンの有効/無効（通常モードは2地点が必要、手動モードは不要）
function updateSubmitState() {
  const ready = els.manualCheck.checked || (state.start && state.end);
  els.button.disabled = state.loading || !ready;
}

// ----- Nominatim（1.1秒以上の間隔を空けて順番に実行） -----
let nominatimQueue = Promise.resolve();
let lastNominatimAt = 0;
function nominatimGet(path, params) {
  const task = nominatimQueue.then(async () => {
    const wait = lastNominatimAt + 1100 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastNominatimAt = Date.now();
    const res = await fetch("https://nominatim.openstreetmap.org/" + path + "?" + new URLSearchParams(params));
    if (!res.ok) throw new Error("HTTP " + res.status);
    return res.json();
  });
  nominatimQueue = task.catch(() => {});
  return task;
}
// API①：座標→地点名（失敗しても検索は続けるので例外を投げない）
async function reverseGeocode(lat, lon) {
  const key = lat.toFixed(5) + "," + lon.toFixed(5);
  if (reverseCache.has(key)) return reverseCache.get(key);
  try {
    const d = await nominatimGet("reverse", { lat, lon, format: "jsonv2", "accept-language": "ja", zoom: 18, addressdetails: 1 });
    const a = (d && d.address) || {};
    const parts = [d && d.name, a.suburb || a.city_district, a.city || a.town || a.village, a.state].filter(Boolean);
    const name = parts.length ? parts.join("、") : (d && d.display_name) || FALLBACK_NAME;
    reverseCache.set(key, name);
    return name;
  } catch (e) { console.error("reverse geocoding failed:", e); return FALLBACK_NAME; }
}

// ----- 表示更新 -----
function updateStatus() {
  let text = "出発地と到着地を選択しました。「ちょうどいい一話を探す」を押してください。";
  if (state.selecting === "start") text = "地図上で出発地点を選んでください";
  if (state.selecting === "end") text = "地図上で到着地点を選んでください";
  els.status.textContent = text;
  els.btnPickStart.setAttribute("aria-pressed", String(state.selecting === "start"));
  els.btnPickEnd.setAttribute("aria-pressed", String(state.selecting === "end"));
  els.btnSwap.disabled = !(state.start && state.end);
}
function renderPoints() {
  const blocks = ["start", "end"].map((role) => {
    const box = el("div", "point");
    const p = state[role];
    box.append(el("h3", "", ROLE_LABEL[role]));
    if (!p) { box.append(el("p", "meta", "まだ選択されていません")); return box; }
    box.append(el("p", "show", p.name), el("p", "meta", "緯度：" + p.lat.toFixed(6)), el("p", "meta", "経度：" + p.lon.toFixed(6))); // 表示のみ6桁
    return box;
  });
  els.pointsView.replaceChildren(...blocks);
  updateStatus();
  updateSubmitState();
}
function setSelecting(role) { state.selecting = role; updateStatus(); }

// ----- マーカー -----
function createMarkerElement(role) {
  const d = el("div", "marker " + role, role === "start" ? "出" : "着");
  d.setAttribute("aria-label", ROLE_LABEL[role] + "のマーカー");
  return d;
}
function placeMarker(role) {
  const p = state[role];
  if (!state.map || !p) return;
  if (state.markers[role]) { state.markers[role].setLngLat([p.lon, p.lat]); return; } // 既存マーカーを移動
  const marker = new maplibregl.Marker({ element: createMarkerElement(role), draggable: true }).setLngLat([p.lon, p.lat]).addTo(state.map);
  marker.on("dragend", () => { const ll = marker.getLngLat(); setPoint(role, ll.lng, ll.lat); }); // ドラッグ終了時に1回だけ
  state.markers[role] = marker;
}
// 地点を保存→マーカー→表示→地点名を後から取得
async function setPoint(role, lon, lat, knownName) {
  const point = { lon, lat, name: knownName || FALLBACK_NAME };
  state[role] = point;
  placeMarker(role);
  renderPoints();
  if (!knownName) {
    const name = await reverseGeocode(lat, lon);
    if (state[role] === point) { point.name = name; renderPoints(); } // 途中で変更されていなければ更新
  }
}
function advanceSelecting(role) { setSelecting(role === "start" ? "end" : null); }

// ----- 経路線（失敗しても検索は継続） -----
function decodePolyline(str) {
  const out = []; let i = 0, lat = 0, lon = 0;
  const next = () => { let b, shift = 0, r = 0; do { b = str.charCodeAt(i++) - 63; r |= (b & 31) << shift; shift += 5; } while (b >= 32); return r & 1 ? ~(r >> 1) : r >> 1; };
  while (i < str.length) { lat += next(); lon += next(); out.push([lon / 1e6, lat / 1e6]); } // Valhallaはpolyline6
  return out;
}
function clearRoute() {
  const m = state.map; if (!m) return;
  try { if (m.getLayer("route-line")) m.removeLayer("route-line"); if (m.getSource("route")) m.removeSource("route"); } catch (e) { console.error(e); }
}
function drawRoute(shape) {
  try {
    clearRoute();
    if (!state.map || typeof shape !== "string") return;
    const coords = decodePolyline(shape);
    state.map.addSource("route", { type: "geojson", data: { type: "Feature", geometry: { type: "LineString", coordinates: coords } } });
    state.map.addLayer({ id: "route-line", type: "line", source: "route", layout: { "line-cap": "round", "line-join": "round" },
      paint: { "line-color": "#0f8b8d", "line-width": 5, "line-opacity": 0.8 } });
    const b = coords.reduce((bb, c) => bb.extend(c), new maplibregl.LngLatBounds(coords[0], coords[0]));
    state.map.fitBounds(b, { padding: 60, duration: 600 });
  } catch (e) { console.error("route drawing failed:", e); }
}

// ----- 場所名検索（ボタンを押した時だけ） -----
function chooseCandidate(role, c) {
  els.candidates.hidden = true; els.candidates.replaceChildren();
  setPoint(role, c.lon, c.lat, c.name || c.displayName);
  advanceSelecting(role);
  if (state.map) state.map.flyTo({ center: [c.lon, c.lat], zoom: 15 });
}
function renderCandidates(role, list) {
  const ul = el("ul", "cand-list");
  list.forEach((c) => {
    const li = el("li");
    const btn = el("button", "sub", "この場所を選ぶ"); btn.type = "button";
    btn.addEventListener("click", () => chooseCandidate(role, c));
    li.append(el("strong", "", c.name || c.displayName), el("p", "meta", c.displayName), el("p", "meta", "種類：" + (c.type || "不明")), btn);
    ul.append(li);
  });
  els.candidates.replaceChildren(el("p", "meta", ROLE_LABEL[role] + "の候補を選んでください"), ul);
  els.candidates.hidden = false;
}
async function searchPlaces(role) {
  clearError();
  const q = (role === "start" ? els.from : els.to).value.trim();
  if (!q) { showError(ROLE_LABEL[role] + "の場所名を入力してください。"); return; }
  if (state.searching) return; // 二重送信防止
  state.searching = true; els.searchFrom.disabled = els.searchTo.disabled = true;
  try {
    let list = searchCache.get(q);
    if (!list) {
      const data = await nominatimGet("search", { q, format: "jsonv2", countrycodes: "jp", "accept-language": "ja", addressdetails: 1, limit: 5 });
      if (!Array.isArray(data)) throw new AppError("場所検索から想定外のデータが返されました。");
      list = data.map((d) => ({ lat: Number(d.lat), lon: Number(d.lon), displayName: d.display_name || "", name: d.name || "", type: d.type || "", importance: d.importance }))
        .filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lon));
      if (data.length > 0 && list.length === 0) throw new AppError("候補の座標が不正でした。別の場所名をお試しください。");
      searchCache.set(q, list);
    }
    if (list.length === 0) throw new AppError(`${ROLE_LABEL[role]}「${q}」が見つかりませんでした。別の表記でお試しください。`);
    if (list.length === 1) chooseCandidate(role, list[0]); else renderCandidates(role, list);
  } catch (e) {
    console.error(e);
    showError(e.userMessage || "ネットワークエラーです。接続を確認してもう一度お試しください。");
  } finally { state.searching = false; els.searchFrom.disabled = els.searchTo.disabled = false; }
}

// ----- 現在地・入れ替え・リセット -----
function locateMe() {
  clearError();
  if (!navigator.geolocation) { showError("このブラウザは位置情報に対応していません。"); return; }
  els.btnLocate.disabled = true; els.btnLocate.textContent = "現在地を取得中…";
  const done = () => { els.btnLocate.disabled = false; els.btnLocate.textContent = "現在地を出発地にする"; };
  navigator.geolocation.getCurrentPosition((pos) => {
    done();
    const { latitude, longitude } = pos.coords;
    setPoint("start", longitude, latitude);
    if (state.map) state.map.flyTo({ center: [longitude, latitude], zoom: 15 });
    setSelecting("end");
  }, (err) => {
    done(); console.error(err);
    const msg = { 1: "位置情報の利用が拒否されました。ブラウザの設定を確認してください。", 3: "位置情報の取得がタイムアウトしました。" };
    showError(msg[err.code] || "現在地を取得できませんでした。");
  }, { enableHighAccuracy: true, timeout: 10000 });
}
function swapPoints() {
  if (!(state.start && state.end)) return;
  [state.start, state.end] = [state.end, state.start];
  placeMarker("start"); placeMarker("end"); renderPoints();
}
function resetSelection() {
  Object.values(state.markers).forEach((m) => m.remove());
  state.markers = {}; state.start = null; state.end = null;
  clearRoute(); clearError();
  clearResults(); els.summary.hidden = true; els.progress.hidden = true;
  els.candidates.hidden = true; els.candidates.replaceChildren();
  setSelecting("start"); renderPoints();
  if (state.map) state.map.flyTo({ center: MAP_CENTER, zoom: MAP_ZOOM });
}
function setInputMode(useName) {
  els.nameFields.hidden = !useName;
  els.modeMapBtn.setAttribute("aria-pressed", String(!useName));
  els.modeNameBtn.setAttribute("aria-pressed", String(useName));
}

// ----- 地図の初期化 -----
function initMap() {
  if (typeof maplibregl === "undefined") { showError("地図ライブラリを読み込めませんでした。場所名検索か手動入力は使えます。"); return; }
  try {
    state.map = new maplibregl.Map({ container: "map", style: "https://tiles.openfreemap.org/styles/liberty",
      center: MAP_CENTER, zoom: MAP_ZOOM, bearing: 0, pitch: 0 });
    state.map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
    state.map.on("error", (e) => {
      console.error(e);
      if (!state.mapErrorShown) { state.mapErrorShown = true; showError("地図の読み込みに失敗しました。通信状況を確認して再読み込みしてください。"); }
    });
    state.map.on("click", (e) => { // クリック/タップで現在の選択モードの地点を設定
      if (!state.selecting) return;
      const role = state.selecting;
      setPoint(role, e.lngLat.lng, e.lngLat.lat);
      advanceSelecting(role);
    });
  } catch (e) { console.error(e); showError("地図を表示できませんでした。"); }
}
function initMapFeature() {
  els.modeMapBtn.addEventListener("click", () => setInputMode(false));
  els.modeNameBtn.addEventListener("click", () => setInputMode(true));
  els.searchFrom.addEventListener("click", () => searchPlaces("start"));
  els.searchTo.addEventListener("click", () => searchPlaces("end"));
  [["from", "start"], ["to", "end"]].forEach(([k, role]) => els[k].addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") { ev.preventDefault(); searchPlaces(role); } // Enterでも検索ボタン扱い
  }));
  els.btnPickStart.addEventListener("click", () => setSelecting("start"));
  els.btnPickEnd.addEventListener("click", () => setSelecting("end"));
  els.btnLocate.addEventListener("click", locateMe);
  els.btnSwap.addEventListener("click", swapPoints);
  els.btnReset.addEventListener("click", resetSelection);
  els.manualCheck.addEventListener("change", updateSubmitState);
  renderPoints();
  initMap();
}

function init() {
  if (Object.values(els).some((v) => v === null)) { console.error("DOM要素が見つかりません"); return; }
  els.from.value = DEFAULTS.from; els.to.value = DEFAULTS.to;
  els.mode.value = DEFAULTS.mode; els.genre.value = DEFAULTS.genre;
  els.manualCheck.addEventListener("change", toggleManualFields);
  els.form.addEventListener("submit", handleSubmit);
  els.moreBtn.addEventListener("click", handleMoreClick);
  els.content.addEventListener("change", () => { // 種別を変えたらジャンルを切り替え、古い結果を消す
    updateGenreOptions(); clearResults(); els.summary.hidden = true;
  });
  initMapFeature();
}
init();

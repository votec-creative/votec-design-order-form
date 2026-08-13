/* =============================================
   VOTEC デザインオーダーフォーム — form.js
   フォームロジック・バリデーション・ナビゲーション
   ============================================= */

let currentStep = 1;
let maxVisitedStep = 1;
let instructionNotice = '';
const totalSteps = 6;
// テスト中のみ true。false に戻すと通常の必須入力チェックが有効になります。
const TEST_MODE_ALLOW_INCOMPLETE_NAVIGATION = true;
const DRAFT_STORAGE_KEY = 'votec-design-order-form-draft-v1';
// Google Apps Scriptをデプロイ後、このURLを設定すると起動時に最新カレンダーを取得します。
const CALENDAR_API_URL = '';
const DELIVERY_SCHEDULE_BY_DATE = new Map();
const LEGACY_DESIGN_INSTRUCTION_TEMPLATE = '■掲載文言\n\n■デザイン指示\n';
const DESIGN_INSTRUCTION_TEMPLATE = '';

// 「パーセンテージの変動」シートの DO用稼働列（I列）を参照した納期指定用の休業日。
// フォーム単体で動作するよう、現行シートの2026年8月〜2027年3月分をスナップショットしています。
const DELIVERY_NON_WORKING_DATES = new Set([
  '2026-08-08','2026-08-09','2026-08-11','2026-08-12','2026-08-13','2026-08-14','2026-08-15','2026-08-16','2026-08-22','2026-08-23','2026-08-29','2026-08-30',
  '2026-09-05','2026-09-06','2026-09-12','2026-09-13','2026-09-19','2026-09-20','2026-09-21','2026-09-22','2026-09-23','2026-09-26','2026-09-27',
  '2026-10-03','2026-10-04','2026-10-07','2026-10-08','2026-10-09','2026-10-10','2026-10-11','2026-10-12','2026-10-17','2026-10-18','2026-10-24','2026-10-25','2026-10-31',
  '2026-11-01','2026-11-03','2026-11-07','2026-11-08','2026-11-11','2026-11-12','2026-11-13','2026-11-14','2026-11-15','2026-11-21','2026-11-22','2026-11-23','2026-11-28','2026-11-29',
  '2026-12-04','2026-12-05','2026-12-06','2026-12-12','2026-12-13','2026-12-19','2026-12-20','2026-12-26','2026-12-27','2026-12-28','2026-12-29','2026-12-30','2026-12-31',
  '2027-01-01','2027-01-02','2027-01-03','2027-01-04','2027-01-09','2027-01-10','2027-01-11','2027-01-16','2027-01-17','2027-01-23','2027-01-24','2027-01-30','2027-01-31',
  '2027-02-06','2027-02-07','2027-02-11','2027-02-13','2027-02-14','2027-02-20','2027-02-21','2027-02-23','2027-02-27','2027-02-28',
  '2027-03-06','2027-03-07','2027-03-13','2027-03-14','2027-03-20','2027-03-21','2027-03-27','2027-03-28'
]);

function isNonWorkingDeliveryDate(value) {
  if (!value) return false;
  const liveSchedule = DELIVERY_SCHEDULE_BY_DATE.get(value);
  if (liveSchedule) return String(liveSchedule.doWork || '').includes('稼働日外');
  const date = new Date(`${value}T00:00:00`);
  return date.getDay() === 0 || date.getDay() === 6 || DELIVERY_NON_WORKING_DATES.has(value);
}

function ensureDesignInstructionTemplate(value) {
  return String(value || '');
}

function stripLegacyDesignInstructionTemplate(value) {
  const text = String(value || '');
  if (text === LEGACY_DESIGN_INSTRUCTION_TEMPLATE) return '';
  if (text.startsWith(LEGACY_DESIGN_INSTRUCTION_TEMPLATE)) {
    return text.slice(LEGACY_DESIGN_INSTRUCTION_TEMPLATE.length).replace(/^\n/, '');
  }
  return text;
}

function splitLegacyInstructionText(value) {
  const text = String(value || '').replace(/\r\n?/g, '\n');
  if (!text) return { copyTxt: '', designTxt: '' };
  const copyHeading = /\u63b2\u8f09\u6587\u8a00/;
  const designHeading = /\u30c7\u30b6\u30a4\u30f3\u6307\u793a/;
  const copyIndex = text.search(copyHeading);
  const designIndex = text.search(designHeading);
  if (copyIndex < 0 && designIndex < 0) return { copyTxt: '', designTxt: text };
  const copyStart = copyIndex >= 0 ? text.indexOf('\n', copyIndex) : -1;
  const designStart = designIndex >= 0 ? text.indexOf('\n', designIndex) : -1;
  return {
    copyTxt: copyStart >= 0 ? text.slice(copyStart + 1, designIndex >= 0 ? designIndex : text.length).trim() : '',
    designTxt: designStart >= 0 ? text.slice(designStart + 1).trim() : ''
  };
}

function hasDesignInstructionContent(value) {
  return String(value || '')
    .replaceAll('■掲載文言', '')
    .replaceAll('■デザイン指示', '')
    .trim().length > 0;
}

function extractDimensions(value) {
  return (String(value || '').match(/\d{2,4}\s*[×xXｘＸ]\s*\d{2,4}/g) || [])
    .map(dimension => dimension.replace(/[xXｘＸ]/g, '×').replace(/\s+/g, ''));
}

function parseBulkInstructions(value) {
  const lines = String(value || '').replace(/\r\n?/g, '\n').split('\n');
  const headers = [];
  lines.forEach((line, index) => {
    const imageNumberMatch = line.match(/(\d+)\s*枚目/);
    const dimensions = extractDimensions(line);
    if (imageNumberMatch && dimensions.length) {
      headers.push({
        index,
        heading: line.trim(),
        imageNumber: Number(imageNumberMatch[1]),
        dimensions
      });
    }
  });
  return headers.map((header, index) => ({
    ...header,
    content: lines.slice(header.index + 1, headers[index + 1]?.index ?? lines.length).join('\n').trim()
  }));
}

function formatBulkDesignInstruction(content) {
  const lines = String(content || '').split('\n');
  const copyHeadingIndex = lines.findIndex(line =>
    /^(?:■\s*)?(?:掲載)?文言\s*[：:]?$/.test(line.trim())
  );
  const designLines = copyHeadingIndex >= 0 ? lines.slice(0, copyHeadingIndex) : lines;
  const copyLines = copyHeadingIndex >= 0 ? lines.slice(copyHeadingIndex + 1) : [];
  return `■掲載文言\n${copyLines.join('\n').trim()}\n\n■デザイン指示\n${designLines.join('\n').trim()}\n`;
}

function setBulkInstructionStatus(message, type = '') {
  const status = document.getElementById('bulk-instruction-status');
  if (!status) return;
  status.className = `bulk-instruction-status${type ? ` ${type}` : ''}`;
  status.textContent = message;
}

function resetBulkInstructions() {
  const hasContent = Boolean(
    state.bulkInstruction?.trim() ||
    (Array.isArray(state.bulkAssetFiles) && state.bulkAssetFiles.length)
  );
  if (!hasContent) {
    setBulkInstructionStatus('リセットする内容はありません。', 'is-error');
    return;
  }
  if (!window.confirm('まとめて入力の文章と共通の参考資料・素材をすべてリセットしますか？\n画像ごとの入力欄に反映済みの内容は残ります。')) return;

  (state.bulkAssetFiles || []).forEach(file => {
    const previewUrl = filePreviewUrls.get(file);
    if (previewUrl) {
      URL.revokeObjectURL(previewUrl);
      filePreviewUrls.delete(file);
    }
  });
  state.bulkInstruction = '';
  state.bulkAssetFiles = [];

  const input = document.getElementById('bulk-instruction-input');
  if (input) input.value = '';
  const fileInput = document.getElementById('bulk-asset-files');
  if (fileInput) fileInput.value = '';
  const errorEl = document.getElementById('bulk-asset-error');
  if (errorEl) {
    errorEl.textContent = '';
    errorEl.style.display = 'none';
  }
  renderBulkAssetFiles();
  saveDraft();
  setBulkInstructionStatus('まとめて入力をリセットしました。', 'is-success');
}

function applyBulkInstructions({ automatic = false } = {}) {
  const input = document.getElementById('bulk-instruction-input');
  const sourceText = input?.value || state.bulkInstruction || '';
  state.bulkInstruction = sourceText;
  if (!sourceText.trim()) {
    setBulkInstructionStatus('制作内容を入力してください。', 'is-error');
    return false;
  }
  saveDraft();
  setBulkInstructionStatus('まとめて入力の内容を保存しました。', 'is-success');
  return true;

  /*
   * 旧仕様の画像別自動振り分け処理は、保存枚数と依頼文内の枚数が一致しない
   * ケースがあるため使用しません。まとめて入力は原文のまま保持します。
   */
  const blocks = parseBulkInstructions(sourceText);
  if (!blocks.length) {
    setBulkInstructionStatus('サイズと「○枚目」を含む見出しを読み取れませんでした。入力例をご確認ください。', 'is-error');
    return false;
  }

  const targets = getInstructionTargets();
  if (!targets.length) {
    setBulkInstructionStatus('先にステップ3で媒体・サイズ・枚数を選択してください。', 'is-error');
    return false;
  }

  targets.forEach(target => {
    const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
    const requiredQuantity = blocks.reduce((maximum, block) => (
      block.dimensions.some(dimension => targetDimensions.includes(dimension))
        ? Math.max(maximum, block.imageNumber)
        : maximum
    ), target.quantity);
    if (requiredQuantity <= target.quantity) return;

    const mediaEntry = state.mediaState[target.mediumName];
    ensureMediaEntryQuantities(mediaEntry);
    if (target.sourceType === 'suggestion') {
      mediaEntry.sizeQuantities[target.sourceKey] = requiredQuantity;
    } else if (target.sourceType === 'custom') {
      mediaEntry.customSizeQuantities[target.sourceIndex] = requiredQuantity;
    }
    target.quantity = requiredQuantity;
  });

  syncInstructionGroups();
  const hasConflicts = blocks.some(block => targets.some(target => {
    const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
    const matchesTarget = block.dimensions.some(dimension => targetDimensions.includes(dimension)) &&
      block.imageNumber >= 1 &&
      block.imageNumber <= target.quantity;
    if (!matchesTarget) return false;
    const card = state.imgCards.find(item =>
      item.targetIds?.[0] === target.id &&
      (Number(item.imageNumber) || 1) === block.imageNumber
    );
    return card &&
      (hasDesignInstructionContent(card.copyTxt) || hasDesignInstructionContent(card.designTxt)) &&
      `${card.copyTxt || ''}\n${card.designTxt || ''}` !== `${splitLegacyInstructionText(formatBulkDesignInstruction(block.content)).copyTxt}\n${splitLegacyInstructionText(formatBulkDesignInstruction(block.content)).designTxt}`;
  }));
  if (automatic && hasConflicts &&
      !window.confirm('画像ごとに入力済みの指示があります。まとめて入力の内容で上書きしますか？')) {
    setBulkInstructionStatus('上書きを取り消しました。個別入力を確認してから、もう一度「次へ」を押してください。', 'is-error');
    return false;
  }
  const overwrite = true;
  const appliedCardKeys = new Set();
  const skippedHeadings = [];

  blocks.forEach(block => {
    const matchingTargets = targets.filter(target => {
      const targetDimensions = extractDimensions(`${target.sizeLabel} ${target.displayName}`);
      return block.dimensions.some(dimension => targetDimensions.includes(dimension)) &&
        block.imageNumber >= 1 &&
        block.imageNumber <= target.quantity;
    });

    if (!matchingTargets.length) {
      skippedHeadings.push(block.heading);
      return;
    }

    matchingTargets.forEach(target => {
      let card = state.imgCards.find(item =>
        item.targetIds?.[0] === target.id &&
        (Number(item.imageNumber) || 1) === block.imageNumber
      );
      if (!card) {
        card = {
          ...makeBlankCard(),
          targetIds: [target.id],
          imageNumber: block.imageNumber
        };
        state.imgCards.push(card);
      }
      const sharedFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
      sharedFiles.forEach(file => {
        if (!card.assetFiles.some(existingFile =>
          existingFile.name === file.name && existingFile.size === file.size
        )) {
          card.assetFiles.push(file);
          appliedCardKeys.add(getInstructionCardKey(card));
        }
      });
      if (!overwrite && (hasDesignInstructionContent(card.copyTxt) || hasDesignInstructionContent(card.designTxt))) {
        skippedHeadings.push(`${block.heading}（入力済み）`);
        return;
      }
      const bulkParts = splitLegacyInstructionText(formatBulkDesignInstruction(block.content));
      card.copyTxt = bulkParts.copyTxt;
      card.designTxt = bulkParts.designTxt;
      appliedCardKeys.add(getInstructionCardKey(card));
    });
  });

  if (appliedCardKeys.size) {
    const firstAppliedIndex = state.imgCards.findIndex(card => appliedCardKeys.has(getInstructionCardKey(card)));
    if (firstAppliedIndex >= 0) state.activeInstructionGroup = firstAppliedIndex;
    renderInstructionGroups();
    saveDraft();
  }

  const skippedSummary = skippedHeadings.length
    ? ` 未反映：${[...new Set(skippedHeadings)].join('、')}`
    : '';
  setBulkInstructionStatus(
    `${appliedCardKeys.size}件の制作画像へ反映しました。${skippedSummary}`,
    appliedCardKeys.size ? 'is-success' : 'is-error'
  );
  return appliedCardKeys.size > 0;
}

const COLOR_OPTIONS = ['赤','ピンク','オレンジ','黄色','緑','青','水色','紫','白','黒','グレー','ゴールド','その他','おまかせ'];
const COLOR_PRESET_CODES = {
  '赤': '#E53935',
  'ピンク': '#EC407A',
  'オレンジ': '#FB8C00',
  '黄色': '#FDD835',
  '緑': '#43A047',
  '青': '#1E88E5',
  '水色': '#4FC3F7',
  '紫': '#8E24AA',
  '白': '#FFFFFF',
  '黒': '#111111',
  'グレー': '#808080',
  'ゴールド': '#D4AF37'
};
const COLOR_ROLE_CONFIG = [
  { key: 'main', label: 'メインカラー', hint: '1色' },
  { key: 'sub', label: 'サブカラー', hint: '任意' },
  { key: 'accent', label: 'アクセントカラー', hint: '任意' }
];
const COLOR_NAME_ALIASES = {
  '金色（ゴールド）': 'ゴールド', '金色': 'ゴールド', 'シルバー': 'グレー', '銀色': 'グレー',
  'ホワイト': '白', 'ブラック': '黒', '灰色（グレー）': 'グレー', '灰色': 'グレー',
  'レッド': '赤', 'イエロー': '黄色', 'グリーン': '緑', 'ブルー': '青', 'パープル': '紫',
  'ブラウン・ベージュ': 'その他', 'ベージュ': 'その他', 'マルチカラー': 'その他'
};
const normalizeColorName = color => COLOR_NAME_ALIASES[color] ?? (COLOR_OPTIONS.includes(color) ? color : '');
const moodGroups = [
  {
    key: 'atmosphere',
    label: '雰囲気',
    hint: '近いものを2つまで選べます。',
    maxSelections: 2,
    sections: [
      { label: '', options: ['シンプル','かわいい','きれい・上品','高級感','かっこいい','明るい・ポップ','落ち着いた','インパクト重視','おまかせ'] }
    ]
  },
  {
    key: 'worldview',
    label: 'デザイン要素・モチーフ',
    hint: '3つまで選べます（任意）',
    maxSelections: 3,
    collapsible: true,
    openKey: 'worldviewOpen',
    sections: [
      { label: '表現スタイル', options: ['写真中心', 'イラスト', 'SNS風', '漫画・吹き出し', '雑誌のような洗練されたデザイン', '立体的・3D'] },
      { label: '装飾・モチーフ', options: ['花・ボタニカル', 'リボン・レース', '和柄・和風', 'ゴールド・金箔', '大理石', 'ジュエリー・宝石'] },
      { label: '色・光', options: ['明るい光', 'パステル・やわらかい色', '透明感', 'キラキラ', 'ネオン', '夜・暗め', 'モノトーン'] },
      { label: 'テイスト', options: ['レトロ・懐かしい', '平成っぽい', '近未来・デジタル風'] }
    ]
  }
];
const ATMOSPHERE_OPTIONS = moodGroups[0].sections.flatMap(section => section.options);
const WORLDVIEW_OPTIONS = moodGroups[1].sections.flatMap(section => section.options);
const VALID_MOOD_OPTIONS = moodGroups.flatMap(group => group.sections
  ? group.sections.flatMap(section => section.options)
  : group.options);
const MAX_REFERENCE_FILE_SIZE = 20 * 1024 * 1024;
const IMAGE_FILE_EXTENSIONS = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp',
  'tif', 'tiff', 'heic', 'heif', 'avif', 'svg', 'ico', 'jxl',
  'raw', 'dng', 'cr2', 'cr3', 'nef', 'arw', 'orf', 'rw2', 'raf'
];
const ARCHIVE_FILE_EXTENSIONS = [
  'zip', 'rar', '7z', 'tar', 'gz', 'tgz', 'bz2', 'xz', 'lzh', 'cab'
];
const PERSON_FILE_EXTENSIONS = [...IMAGE_FILE_EXTENSIONS, ...ARCHIVE_FILE_EXTENSIONS];
const REFERENCE_FILE_EXTENSIONS = [
  ...PERSON_FILE_EXTENSIONS,
  'pdf', 'txt', 'rtf', 'md', 'csv', 'tsv', 'json', 'xml', 'html', 'htm', 'log',
  'doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx',
  'odt', 'ods', 'odp', 'pages', 'numbers', 'key',
  'psd', 'psb', 'ai', 'eps', 'indd', 'xd', 'fig', 'sketch',
  'afdesign', 'afphoto', 'cdr',
  'mp4', 'mov', 'm4v', 'avi', 'wmv', 'mkv', 'webm',
  'mp3', 'wav', 'm4a', 'aac'
];
const PERSON_FILE_ACCEPT = PERSON_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');
const REFERENCE_FILE_ACCEPT = REFERENCE_FILE_EXTENSIONS.map(extension => `.${extension}`).join(',');
const PREVIEWABLE_IMAGE_EXTENSIONS = [
  'png', 'apng', 'jpg', 'jpeg', 'jpe', 'jfif', 'webp', 'gif', 'bmp', 'avif', 'svg'
];
const filePreviewUrls = new WeakMap();

/* Step2: 画像種別（rc-new等のIDサフィックス） */
const IMG_TYPE_CARD_KEYS = ['new', 'fix', 'pay'];

/* Step5: 納期希望の値とラジオボタンIDの対応表 */
const DELIVERY_BUTTON_ID_BY_VALUE = { '希望なし': 'd1', '事前予約': 'd2', '納期指定': 'd3' };

/* ステップインジケーターのアイコンクラス（インデックス1〜6） */
const STEP_ICON_CLASSES = ['', 'ti-user', 'ti-photo', 'ti-layout', 'ti-brush', 'ti-clock', 'ti-check'];

let state = {
  office: '', officeId: 0,
  staff: '', client: '本人', agent: '', email: '',
  imgType: 0, imcUrl: '',
  pay: 'ポイント', payUrl: '',
  shop: '', area: '', shopUrl: '', shopUrl2: '', urlMode: 'あり', urlMode2: 'あり',
  industry: '', industryOther: '', productionType: '', productionTypes: [],
  selectedMedia: [],       // ['バニラ', '駅ちか', ...]
  openMedia: [],
  mediumOther: '',
  mediaState: {},          // { 'バニラ': { selectedSizes, customSizes, sizeQuantities, customSizeQuantities } }
  imgsize: '', count: 0,
  imgMode: 'images',
  activeInstructionGroup: 0,
  bulkInstruction: '',
  bulkAssetFiles: [],
  common: null,            // 共通指示（カードと同じ形のオブジェクト）
  imgCards: [],            // 制作画像ごとの指示カード
  delivery: '', deliveryDate: '',
  des1: '', des2: '', des3: '',
  files: []
};

function makeBlankCard() {
  return {
    targetImage: '',
    personUsage: '', person: '', staffPhotoAllowed: false, personFreeNote: '', personFiles: [],
    design: '', copyTxt: '', designTxt: DESIGN_INSTRUCTION_TEMPLATE,
    allOmakase: false,
    refNote: '', refFiles: [],
    assetNote: '', assetFiles: [], fileShareUrl: '',
    baseColor: '', mainColor: '', accentColor: '',
    baseColorCode: '', mainColorCode: '', accentColorCode: '', colorChoice: '', colorOther: '', colorOtherByRole: {}, colorNote: '',
    moods: [], atmosphereOther: '', worldviewOther: '',
    worldviewOpen: false,
    targetIds: [],
    imageNumber: 1,
    sameAsCardKey: '',
    advancedOpen: false,
    collapsed: false
  };
}
state.common = makeBlankCard();

/* ========== お知らせ・混雑状況 ========== */
/* 混雑状況はサンプル値。実運用では稼働状況データに接続する想定 */
function initCongestion() {
  const congestionLevel = 'normal'; // 'active' | 'normal' | 'busy'
  const iconEl = document.getElementById('congestion-icon');
  const labelEl = document.getElementById('congestion-label');
  const subEl = document.getElementById('congestion-sub');
  iconEl.className = `congestion-icon ${congestionLevel}`;
  if (congestionLevel === 'busy') {
    iconEl.innerHTML = '<i class="ti ti-alert-triangle"></i>';
    labelEl.textContent = '混雑中';
    subEl.innerHTML = '現在、ご依頼が集中しています。<br>納期短縮はご希望に沿えない場合があります。';
  } else if (congestionLevel === 'active') {
    iconEl.innerHTML = '<i class="ti ti-bolt"></i>';
    labelEl.textContent = '積極対応中';
    subEl.innerHTML = '比較的早めに対応できる状況です。<br>追加のご依頼も歓迎しています。';
  } else {
    iconEl.innerHTML = '<i class="ti ti-clock"></i>';
    labelEl.textContent = '通常稼働';
    subEl.textContent = '標準的な対応状況です。';
  }
}

function initNotices() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const noticeBody = document.getElementById('notice-body');
  if (!noticeBody) return;
  noticeBody.querySelectorAll('.info-entry[data-end-date]').forEach(entry => {
    const endDate = new Date(entry.dataset.endDate + 'T23:59:59');
    if (endDate < today) entry.remove();
  });
  if (!noticeBody.querySelector('.info-entry')) {
    noticeBody.innerHTML = '<div class="info-entry"><div class="info-entry-text">現在、お知らせはありません。</div></div>';
  }
}

/* ========== STEP 1 ========== */
function onOffice() {
  const officeSelect = document.getElementById('sel-office');
  const selectedOption = officeSelect.options[officeSelect.selectedIndex];
  state.office = officeSelect.value;
  state.officeId = parseInt(selectedOption.getAttribute('data-id') || 0) || 0;

  const staffSelect = document.getElementById('sel-staff');
  const staffOtherInput = document.getElementById('inp-staff-other');

  if (officeSelect.value === 'VOTEC' || officeSelect.value === 'その他') {
    staffSelect.style.display = 'none';
    staffOtherInput.style.display = 'block';
    staffSelect.innerHTML = '<option value="">-</option>';
  } else {
    staffSelect.style.display = 'block';
    staffOtherInput.style.display = 'none';
    const staffList = staffData[state.officeId] || [];
    staffSelect.innerHTML = '<option value="">選択してください</option>' +
      staffList.map(name => `<option>${name}</option>`).join('');
  }

  const existingNote = document.getElementById('kansai-note');
  if (existingNote) existingNote.remove();
  if (officeSelect.value === '関西支社') {
    const noteEl = document.createElement('div');
    noteEl.id = 'kansai-note';
    noteEl.className = 'warn-box';
    noteEl.style.marginTop = '8px';
    noteEl.innerHTML = '<i class="ti ti-alert-triangle"></i>ご依頼前に太田さんへの確認が必要です';
    document.getElementById('f-office').appendChild(noteEl);
  }
  document.getElementById('f-office').classList.remove('inv');
}

function setClient(value) {
  state.client = value;
  document.getElementById('rb-honin').classList.toggle('sel', value === '本人');
  document.getElementById('rb-dairi').classList.toggle('sel', value === '代理');
  document.getElementById('f-agent').style.display = value === '代理' ? 'block' : 'none';
}

/* ========== STEP 2 ========== */
function setImgType(id) {
  state.imgType = id;
  document.getElementById('f-imgtype').classList.add('has-selection');
  document.getElementById('imgtype-followup').classList.toggle('show', id === 3);
  IMG_TYPE_CARD_KEYS.forEach((key, index) =>
    document.getElementById('rc-' + key).classList.toggle('sel', index + 1 === id)
  );
  setPay(id === 3 ? '有料' : 'ポイント');
  document.getElementById('f-imgtype').classList.remove('inv');
}

function setPay(value) {
  state.pay = value;
  document.getElementById('f-pay-url').style.display = value === '有料' ? 'block' : 'none';
  if (value !== '有料') document.getElementById('f-pay-url').classList.remove('inv');
}

function setUrlMode(target, hasNoUrl) {
  const suffix = target === 2 ? '2' : '';
  state[target === 2 ? 'urlMode2' : 'urlMode'] = hasNoUrl ? 'なし' : 'あり';
  document.getElementById('chk-urlnone' + suffix).checked = hasNoUrl;
  document.getElementById('inp-shopurl' + suffix).disabled = hasNoUrl;
  if (target === 1) document.getElementById('f-shopurl').classList.remove('inv');
}

/* ========== STEP 3: 業種・媒体・サイズ（複数媒体対応） ========== */
function setIndustry(name, el) {
  state.industry = name;
  state.industryOther = '';
  document.querySelectorAll('#industry-btns .rbtn').forEach(btn => btn.classList.remove('sel'));
  el.classList.add('sel');
  document.querySelectorAll('.fuzoku-warn').forEach(warning => {
    warning.style.display = name === '風俗' ? 'flex' : 'none';
  });
  const industryOtherWrap = document.getElementById('f-industry-other');
  const industryOtherInput = document.getElementById('inp-industry-other');
  industryOtherWrap.style.display = name === 'その他' ? 'block' : 'none';
  industryOtherWrap.classList.remove('inv');
  industryOtherInput.value = '';

  state.selectedMedia = [];
  state.openMedia = [];
  state.mediumOther = '';
  state.mediaState = {};
  renderMediumChips(getProductionTypeSelections());
  document.getElementById('inp-medium-other').value = '';
  document.getElementById('medium-blocks').innerHTML = '';
  document.getElementById('f-medium-other').style.display = 'none';
  document.getElementById('f-industry').classList.remove('inv');
  if (name === 'その他') {
    toggleMedium('その他');
    requestAnimationFrame(() => industryOtherInput.focus());
  } else {
    autoFillImgSize();
  }
}

function setProductionType(value, el) {
  const selected = getProductionTypeSelections();
  const index = selected.indexOf(value);
  if (index >= 0) selected.splice(index, 1);
  else selected.push(value);
  state.productionTypes = selected;
  state.productionType = selected.join('・');
  renderMediumChips(selected);
  document.querySelectorAll('#production-type-btns .rbtn').forEach(btn => btn.classList.toggle('sel', selected.includes(btn.textContent.trim())));
  document.getElementById('f-production-type')?.classList.remove('inv');
}

function getProductionTypeSelections() {
  if (Array.isArray(state.productionTypes) && state.productionTypes.length) return state.productionTypes.filter(Boolean);
  return state.productionType ? state.productionType.split('・').filter(Boolean) : [];
}

function relocateIndustryAndAddProductionType() {
  const industry = document.getElementById('f-industry');
  const p2 = document.getElementById('p2');
  // The first `.r2` belongs to the image-type cards. Insert the industry
  // field immediately before the 店舗情報 subhead instead.
  const p2Headings = p2 ? Array.from(p2.children).filter(el => el.classList.contains('subhead')) : [];
  const storeHeading = p2Headings.find(el => el.textContent.includes('店舗情報')) || null;
  if (industry && p2 && industry.parentElement !== p2) {
    if (storeHeading && storeHeading.parentElement === p2) {
      const storeFields = storeHeading.nextElementSibling;
      p2.insertBefore(industry, storeFields || storeHeading.nextSibling);
    }
    else p2.appendChild(industry);
  }

  const p3 = document.getElementById('p3');
  const medium = document.getElementById('f-medium');
  if (!p3 || !medium || document.getElementById('f-production-type')) return;
  const field = document.createElement('div');
  field.className = 'field';
  field.id = 'f-production-type';
  field.innerHTML = `
    <div class="lbl">制作内容 <span class="req">必須</span></div>
    <div class="radios" id="production-type-btns">
      <div class="rbtn" onclick="setProductionType('集客',this)">集客</div>
      <div class="rbtn" onclick="setProductionType('求人',this)">求人</div>
      <div class="rbtn" onclick="setProductionType('スタッフ募集',this)">スタッフ募集</div>
    </div>
    <div class="err" style="display:none">制作内容を選択してください</div>`;
  if (medium.parentElement === p3) p3.insertBefore(field, medium);
  else p3.appendChild(field);
  const productionBadge = field.querySelector('.req');
  if (productionBadge) {
    productionBadge.className = 'opt';
    productionBadge.textContent = '任意・複数選択可';
  }
  const title = p3.querySelector('.ptitle');
  const sub = p3.querySelector('.psub');
  if (title) title.textContent = '媒体・サイズ';
  if (sub) sub.textContent = '媒体を選び、必要な画像サイズを入力してください。';
  document.querySelectorAll('#production-type-btns .rbtn').forEach(btn => {
    btn.classList.toggle('sel', getProductionTypeSelections().includes(btn.textContent.trim()));
  });
  // 制作内容が未選択でも、候補媒体を初期表示する。
  // 制作内容は絞り込み用の任意項目であり、媒体選択を妨げない。
  renderMediumChips(getProductionTypeSelections());
}

const mediaByProductionType = {
  '集客': ['駅ちか','風俗じゃぱん','メンズエステランキング','デリヘルじゃぱん','メンエスじゃぱん','デリヘルが呼べるホテル','デリヘルタウン','夜遊びショコラ','エステ魂','爆サイ.com','メンエスSNS02','駅ちか!パラダイス','口コミ風俗情報局','フーコレ','エステラブ','ホスパラ（集客）','風俗エステランキング','リアクションアップ','Erotic Guide','ホスラブ','G1','オリジナルHP','その他'],
  '求人': ['バニラ','体入エミリー','体入ショコラ','ココア','はじめての風俗アルバイト','体入ホスパラ','メンエスリクルート','Qプリ','エステラブ','R-30','ショコラ','キャバイト','ジャニーズチケット掲示板','その他'],
  'スタッフ募集': ['メンズバニラ','ジョブショコラ','野郎WORK','俺の風','FENIXJOB','その他']
};

function renderMediumChips(productionType) {
  // 業種との紐づけは一旦使わず、登録済みの媒体をすべて表示する。
  // 重複媒体は1件にまとめ、業種は媒体候補の絞り込みには利用しない。
  const seen = new Set();
  const allProductionMedia = [...new Set(Object.values(mediaByProductionType).flat())];
  const mediumPriority = ['バニラ','駅ちか','体入エミリー','風俗じゃぱん','メンズバニラ','体入ショコラ','メンズエステランキング','デリヘルじゃぱん','メンエスじゃぱん','ココア','はじめての風俗アルバイト','体入ホスパラ','デリヘルが呼べるホテル','デリヘルタウン','メンエスリクルート','夜遊びショコラ','エステ魂','爆サイ.com','Qプリ','メンエスSNS02','駅ちか!パラダイス','口コミ風俗情報局','ジョブショコラ','野郎WORK','俺の風','FENIXJOB','フーコレ','R-30','エステラブ','ジャニーズチケット掲示板'];
  const priorityIndex = new Map(mediumPriority.map((name, index) => [name, index]));
  const selectedTypes = Array.isArray(productionType) ? productionType : (productionType ? [productionType] : []);
  const filteredMedia = selectedTypes.length
    ? [...new Set(selectedTypes.flatMap(type => mediaByProductionType[type] || []))]
    : allProductionMedia;
  const mediumList = (filteredMedia || allProductionMedia)
    .filter(name => priorityIndex.has(name) || name === 'その他')
    .slice()
    .sort((a, b) => (priorityIndex.get(a) ?? 999) - (priorityIndex.get(b) ?? 999));
  const chipsWrap = document.getElementById('medium-chips');
  if (!mediumList.length) {
    chipsWrap.innerHTML = '<div style="font-size:13px;color:var(--color-text-muted)">先に制作内容を選択してください</div>';
    return;
  }
  chipsWrap.innerHTML = mediumList.map(mediumName => {
    const isSelected = state.selectedMedia.includes(mediumName);
    return `
      <label class="medium-select-row ${isSelected ? 'is-selected' : ''}" for="mchip-${cssId(mediumName)}">
        <input type="checkbox" id="mchip-${cssId(mediumName)}" ${isSelected ? 'checked' : ''} onchange="toggleMedium('${escJs(mediumName)}')">
        <strong>${escHtml(mediumName)}</strong>
      </label>`;
  }).join('');
}

function cssId(s) { return s.replace(/[^a-zA-Z0-9]/g, c => c.charCodeAt(0)); }
function escJs(s) { return (s || '').replace(/'/g, "\\'"); }

function toggleMedium(mediumName) {
  const existingIndex = state.selectedMedia.indexOf(mediumName);
  if (existingIndex === -1) {
    state.selectedMedia.push(mediumName);
    if (!state.openMedia.includes(mediumName)) state.openMedia.push(mediumName);
    if (!state.mediaState[mediumName]) {
      state.mediaState[mediumName] = {
        selectedSizes: [],
        customSizes: [''],
        sizeQuantities: {},
        customSizeQuantities: [1]
      };
    }
  } else {
    state.selectedMedia.splice(existingIndex, 1);
    delete state.mediaState[mediumName];
    state.openMedia = state.openMedia.filter(item => item !== mediumName);
  }
  document.getElementById('f-medium-other').style.display = state.selectedMedia.includes('その他') ? 'block' : 'none';
  document.getElementById('f-medium').classList.remove('inv');
  renderMediumChips(getProductionTypeSelections());
  renderMediumBlocks();
  autoFillImgSize();
}

function toggleMediumAccordion(mediumName) {
  if (!state.selectedMedia.includes(mediumName)) {
    toggleMedium(mediumName);
    return;
  }
  if (state.openMedia.includes(mediumName)) {
    state.openMedia = state.openMedia.filter(item => item !== mediumName);
  } else {
    state.openMedia.push(mediumName);
  }
  renderMediumBlocks();
}

function renderMediumBlocks() {
  const wrap = document.getElementById('medium-blocks');
  if (!wrap) return;
  if (!state.selectedMedia.length) {
    wrap.innerHTML = '';
    return;
  }
  wrap.innerHTML = `
    <div class="medium-settings-heading">
      <strong>サイズ入力</strong>
      <span>選択した媒体ごとに設定してください</span>
    </div>
  ` + state.selectedMedia.map(mediumName => {
    const isOpen = true;
    const mediaEntry = state.mediaState[mediumName];
    ensureMediaEntryQuantities(mediaEntry);
    const suggestions = getSizeSuggestions(mediumName);
    const heading = mediumName === 'その他' ? 'その他媒体' : mediumName;
    const selectedEntries = getSelectedSizeEntriesForMedium(mediumName);
    const mediumTotal = selectedEntries.reduce((total, entry) => total + entry.quantity, 0);
    const settingSummary = selectedEntries.length
      ? `${selectedEntries.length}サイズ・${mediumTotal}枚`
      : 'サイズ未設定';
    const suggestionHtml = suggestions.length ? `
      <details class="size-suggestion-details" ${mediaEntry.selectedSizes.length ? 'open' : ''}>
        <summary>よく使うサイズ候補から選ぶ</summary>
        <div class="size-section">
          <div class="size-grid">
            ${suggestions.map(sizeLabel =>
              renderSizeSuggestion(
                mediumName,
                sizeLabel,
                mediaEntry.selectedSizes.includes(sizeLabel),
                mediaEntry.sizeQuantities[sizeLabel] || 1
              )
            ).join('')}
          </div>
        </div>
      </details>` : `<div class="size-catalog-note">登録済みのサイズ候補はありません。下の入力欄へ直接入力してください。</div>`;
    return `
    <section class="medium-accordion is-selected ${isOpen ? 'is-open' : ''}" id="mb-${cssId(mediumName)}">
      <div class="medium-accordion-head">
        <strong class="medium-accordion-title">${escHtml(heading)}</strong>
        <span class="medium-accordion-status ${selectedEntries.length ? 'is-set' : 'is-empty'}">${settingSummary}</span>
      </div>
      <div class="medium-accordion-body" ${isOpen ? '' : 'hidden'}>
        ${suggestionHtml}
        <div class="field medium-size-field" id="f-size-${cssId(mediumName)}">
        <div class="lbl">サイズを入力 <span class="opt">任意</span></div>
        <div class="hint">画像名を含めても構いません。例：メイン 700×300</div>
        <div class="size-input-list">
          ${mediaEntry.customSizes.map((sizeValue, sizeIndex) => `
            <div class="size-input-row">
              <input type="text" class="control-w-md" id="custom-size-${cssId(mediumName)}-${sizeIndex}" placeholder="例：700×300" value="${escAttr(sizeValue)}" oninput="updateCustomSize('${escJs(mediumName)}',${sizeIndex},this.value)">
              ${renderQuantityStepper(
                mediaEntry.customSizeQuantities[sizeIndex],
                `adjustSizeQuantity('${escJs(mediumName)}','custom',${sizeIndex},-1)`,
                `adjustSizeQuantity('${escJs(mediumName)}','custom',${sizeIndex},1)`,
                `${heading}の入力サイズ`
              )}
              ${mediaEntry.customSizes.length > 1 ? `<button type="button" class="size-remove-btn" onclick="removeCustomSize('${escJs(mediumName)}',${sizeIndex})"><i class="ti ti-x"></i>削除</button>` : ''}
            </div>`).join('')}
        </div>
        <button type="button" class="size-add-btn" onclick="addCustomSize('${escJs(mediumName)}')"><i class="ti ti-plus"></i>サイズを追加</button>
        <div class="err">サイズを入力するか、候補から選択してください</div>
        </div>
      </div>
    </section>`;
  }).join('');
  syncMediumAccordionSymbols();
}

function syncMediumAccordionSymbols() {
  document.querySelectorAll('.medium-accordion-toggle').forEach(button => {
    const symbol = button.querySelector('.medium-accordion-symbol');
    if (symbol) symbol.textContent = button.getAttribute('aria-expanded') === 'true' ? '\u2303' : '\u2304';
  });
}

function ensureMediaEntryQuantities(mediaEntry) {
  if (!mediaEntry.sizeQuantities) mediaEntry.sizeQuantities = {};
  if (!mediaEntry.customSizeQuantities) mediaEntry.customSizeQuantities = [];
  while (mediaEntry.customSizeQuantities.length < mediaEntry.customSizes.length) {
    mediaEntry.customSizeQuantities.push(1);
  }
}

function renderQuantityStepper(quantity, decreaseAction, increaseAction, contextLabel) {
  return `
    <div class="size-quantity-stepper" aria-label="${escAttr(contextLabel)}の枚数">
      <button type="button" aria-label="枚数を1枚減らす" onclick="${decreaseAction}" ${quantity <= 1 ? 'disabled' : ''}>−</button>
      <strong>${quantity}枚</strong>
      <button type="button" aria-label="枚数を1枚増やす" onclick="${increaseAction}">＋</button>
    </div>`;
}

// Googleスプレッドシート「媒体サイズ」から読み取った新規媒体のサイズ候補。
// 元シートは変更せず、フォーム側の候補データとして保持する。
Object.assign(planSizeData, {
  'リアクションアップ': [{ plan: '基本', sizes: ['正方形 1080×1080', '縦長 1080×1920'] }],
  '夜遊びショコラ': [{ plan: 'A・B・Cプラン', sizes: ['メイン 1000×428', '上位プラン大画像PC 1920×1080', '上位プラン大画像SP 640×512'] }],
  'デリヘルタウン': [{ plan: '全プラン共通', sizes: ['集客ヘッダー 1000×560', 'SP一覧用 300×300'] }, { plan: 'SSSプラン', sizes: ['エリアトップ 200×200'] }, { plan: 'オプション', sizes: ['PR広告 300×300'] }],
  '口コミ風俗情報局': [{ plan: '全プラン', sizes: ['PC 976×211', 'SP 500×180', '求人 700×300'] }, { plan: '特上以上', sizes: ['サムネイルPC 364×286', 'サムネイルSP 441×196'] }],
  'デリヘルが呼べるホテル': [{ plan: '通常', sizes: ['集客用 750×150'] }, { plan: '都道府県グループバナー', sizes: ['集客用PC 1500×200', '集客用SP 1500×400'] }],
  'Qプリ': [{ plan: '通常掲載', sizes: ['店舗一覧PC 314×150', '店舗詳細PC 780×213', '店舗一覧SP 500×400', '店舗詳細SP 640×512'] }, { plan: 'プレミアムVIP', sizes: ['SP上部スライダー 560×420', 'SP中部スライダー 640×275', 'PCエリアトップ 500×83', 'PC都道府県トップ 670×112', 'PCサイド 200×80'] }],
  'フーコレ': [{ plan: '全プラン', sizes: ['アイコン 200×200', '告知バナー 800×260', '求人バナー 600×300'] }, { plan: '極', sizes: ['極バナー 800×350'] }],
  '俺の風': [{ plan: '全プラン', sizes: ['サブ画像 500×288', '急募コメント用画像 180×180', '一覧用画像 694×400'] }, { plan: 'TOPオプション', sizes: ['一覧オススメ 640×640'] }],
  'はじめての風俗アルバイト': [{ plan: '各プラン共通', sizes: ['メイン 700×300', 'サブメイン 520×300', 'サムネイル 160×160', 'サブ画像 320×240', '追加サブ画像 260×150'] }, { plan: 'スマホ検索オプション', sizes: ['検索バナー 640×100'] }],
  '体入エミリー': [{ plan: 'A・Bプラン', sizes: ['メイン 750×600', '未経験サムネ 240×180', 'お店からのメッセージ 700×16000'] }, { plan: 'グループ掲載', sizes: ['グループ掲載 800×450'] }],
  '体入ショコラ': [{ plan: 'SSS・SS・S・Aプラン', sizes: ['メインSP 640×512', 'メインPC 1920×1536', '背景 1920×16000', 'SHOP GALLERY 640×486'] }, { plan: 'B・Cプラン', sizes: ['メイン 640×512', 'SHOP GALLERY 640×486'] }],
  'ジョブショコラ': [{ plan: '全プラン', sizes: ['メインSP 640×512', 'メインPC 1920×1536'] }, { plan: 'オプション', sizes: ['オプション 700×300'] }],
  'メンエスSNS02': [{ plan: '基本', sizes: ['エリアバナー 800×400', 'インフィードバナー 900×1200', '全国版エリアバナー 800×400', 'マイページバナー 500×500'] }],
  'メンエスリクルート': [{ plan: '基本掲載', sizes: ['基本掲載 600×600', '今月の急募 640×640'] }],
  'エステラブ': [{ plan: '基本', sizes: ['集客・求人 420×315'] }],
  'エステ魂': [{ plan: '基本掲載', sizes: ['メイン画像 1000×500'] }],
  'FENIXJOB': [{ plan: '各プラン', sizes: ['背景 2000×500', '企業バナー 400×160', 'メイン 700×340', 'サブ画像 660×420'] }],
  '野郎WORK': [{ plan: 'プラチナ', sizes: ['メイン 460×270', 'トップ 200×80', 'ヘッダー 890×290', 'サブ画像 320×220'] }, { plan: 'ゴールド・シルバー', sizes: ['メイン 460×270', 'ヘッダー 890×290'] }],
  'Erotic Guide': [{ plan: '基本', sizes: ['通常枠 630×420', '通常枠 2000×800', 'ライト枠 630×420', 'VIPバナー 500×120', 'BIGバナー 960×350', 'TOPバナー 500×120', 'サイドバナー 336×280'] }],
  'ホスラブ': [{ plan: '通常・VIP', sizes: ['通常枠 640×200', 'VIP版 600×240', 'A枠 120×75', '板枠 192×53', '入口トップ 880×240', '独占コメント広告 600×500'] }]
  ,'ジャニーズチケット掲示板': [{ plan: '基本掲載', sizes: ['基本掲載 300×150'] }]
});

Object.assign(planSizeData, {
  'R-30': [
    { plan: '基本プラン', sizes: ['140X110', '580X200', '640X480'] },
    { plan: 'TOPバナープラン', sizes: ['200X80', '140X110', '580X200', '640X480'] },
    { plan: '注目のお仕事プラン', sizes: ['190X120', '140X110', '580X200', '640X480'] },
    { plan: 'VIPバナープラン', sizes: ['200X200', '300X237', '140X110', '580X200', '640X480'] },
    { plan: 'スマホ特別バナー', sizes: ['640X140'] },
    { plan: 'スペシャルバナー', sizes: ['640X140'] },
    { plan: 'ライトプラン', sizes: ['140X110'] },
    { plan: '即日体験入店', sizes: ['580X200'] }
  ]
});

function getSizeSuggestions(mediumName) {
  const sizeGroups = [];
  const flexibleSuggestions = mediumName === 'R-30' ? ['580×タテ自由'] : [];
  (planSizeData[mediumName] || []).forEach(plan => {
    const sizes = (plan.sizes || []).filter(sizeLabel => /\d/.test(sizeLabel) && /[×xX]/.test(sizeLabel));
    sizes.forEach(sizeLabel => {
      const keepSeparate = mediumName === '駅ちか' && plan.plan === '駅DX';
      const displayPlanName = normalizePlanNameForDisplay(mediumName, plan.plan);
      const displaySizeLabel = normalizeSizeLabelForDisplay(mediumName, sizeLabel);
      const groupKey = keepSeparate ? `${displayPlanName}:${displaySizeLabel}` : displaySizeLabel;
      const existingGroup = sizeGroups.find(group => group.key === groupKey);
      if (existingGroup) {
        existingGroup.planNames.push(displayPlanName);
      } else {
        sizeGroups.push({ key: groupKey, planNames: [displayPlanName], sizeLabel: displaySizeLabel });
      }
    });
  });
  return flexibleSuggestions.concat(sizeGroups
    .map(group => formatPlanSizeLabel(formatCombinedPlanName(group.planNames), group.sizeLabel))
    .sort((left, right) => getSizeSuggestionPriority(left) - getSizeSuggestionPriority(right)));
}

function normalizePlanNameForDisplay(mediumName, planName) {
  return mediumName === '爆サイ.com' ? planName.replace(/^【\d+】/, '') : planName;
}

function normalizeSizeLabelForDisplay(mediumName, sizeLabel) {
  return mediumName === '爆サイ.com' ? sizeLabel.replace(/^【\d+】/, '') : sizeLabel;
}

function formatCombinedPlanName(planNames) {
  if (planNames.length > 1 && planNames.every(planName => planName.endsWith('プラン'))) {
    return `${planNames.map(planName => planName.slice(0, -3)).join('・')}プラン`;
  }
  const alphaPlans = planNames.map(planName => planName.match(/^(.*?)([A-Z])$/));
  if (planNames.length > 1 && alphaPlans.every(Boolean) && alphaPlans.every(match => match[1] === alphaPlans[0][1])) {
    const prefix = alphaPlans[0][1];
    const letters = alphaPlans.map(match => match[2]);
    const isContinuousRange = letters.length >= 3 &&
      letters.every((letter, index) => letter.charCodeAt(0) === letters[0].charCodeAt(0) + index);
    return isContinuousRange ? `${prefix}${letters[0]}～${letters[letters.length - 1]}` : `${prefix}${letters.join('・')}`;
  }
  return planNames.join('・');
}

function getSizeSuggestionPriority(sizeLabel) {
  return sizeLabel.includes('メイン') ? 0 : 1;
}

function formatPlanSizeLabel(planName, sizeLabel) {
  return planName ? `【${planName}】${sizeLabel}` : sizeLabel;
}

function splitSizeSuggestion(sizeLabel) {
  const tags = [];
  let remainder = sizeLabel.trim();
  if (/^\d+\s*[×xX]\s*タテ自由$/.test(remainder)) {
    return { plan: '', title: '', dimension: remainder.replace(/\s+/g, ''), note: '' };
  }
  let tagMatch = remainder.match(/^【([^】]+)】\s*/);
  while (tagMatch) {
    tags.push(tagMatch[1]);
    remainder = remainder.slice(tagMatch[0].length);
    tagMatch = remainder.match(/^【([^】]+)】\s*/);
  }
  const dimensionMatch = remainder.match(/^(.*?)(\d+\s*[×xX]\s*\d+)(.*)$/);
  const labelPrefix = dimensionMatch ? dimensionMatch[1].trim() : remainder;
  const dimension = dimensionMatch ? dimensionMatch[2].replace(/\s+/g, '') : labelPrefix;
  const suffix = dimensionMatch ? dimensionMatch[3].trim() : '';
  const noteMatch = suffix.match(/^([（(].*)$/);
  return {
    plan: tags[0] || '',
    title: [tags.slice(1).join(' / '), labelPrefix].filter(Boolean).join(' / '),
    dimension,
    note: noteMatch ? noteMatch[1].trim() : suffix
  };
}

function getSizeSuggestionPlanName(mediumName, sizeLabel) {
  const planMatch = sizeLabel.match(/^【([^】]+)】/);
  return planMatch ? planMatch[1] : '';
}

function renderSizeSuggestion(mediumName, sizeLabel, isSelected, quantity) {
  const suggestion = splitSizeSuggestion(sizeLabel);
  const checkboxId = `size-choice-${cssId(mediumName)}-${cssId(sizeLabel)}`;
  return `
    <div class="size-item size-option-card ${isSelected ? 'chk' : ''}" data-medium="${escAttr(mediumName)}" title="${escAttr(sizeLabel)}">
      <input type="checkbox" id="${checkboxId}" ${isSelected ? 'checked' : ''} onchange="toggleSizeSuggestion('${escJs(mediumName)}','${escJs(sizeLabel)}',this)">
      <label class="size-option-content" for="${checkboxId}">
        ${suggestion.title ? `<span class="size-option-title">${escHtml(suggestion.title)}</span>` : ''}
        <strong class="size-option-dimension">${escHtml(suggestion.dimension)}</strong>
        ${suggestion.plan ? `<span class="size-option-plan">${escHtml(suggestion.plan)}</span>` : ''}
        ${suggestion.note ? `<span class="size-option-note">${escHtml(suggestion.note)}</span>` : ''}
      </label>
      ${isSelected ? renderQuantityStepper(
        quantity,
        `adjustSizeQuantity('${escJs(mediumName)}','suggestion','${escJs(sizeLabel)}',-1)`,
        `adjustSizeQuantity('${escJs(mediumName)}','suggestion','${escJs(sizeLabel)}',1)`,
        `${sizeLabel}`
      ) : ''}
    </div>`;
}

function toggleSizeSuggestion(mediumName, sizeLabel, checkbox) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  if (checkbox.checked) {
    if (!mediaEntry.selectedSizes.includes(sizeLabel)) mediaEntry.selectedSizes.push(sizeLabel);
    if (!mediaEntry.sizeQuantities[sizeLabel]) mediaEntry.sizeQuantities[sizeLabel] = 1;
  } else {
    mediaEntry.selectedSizes = mediaEntry.selectedSizes.filter(item => item !== sizeLabel);
    delete mediaEntry.sizeQuantities[sizeLabel];
  }
  if (hasMediumSize(mediumName)) document.getElementById('f-size-' + cssId(mediumName)).classList.remove('inv');
  renderMediumBlocks();
  autoFillImgSize();
}

function adjustSizeQuantity(mediumName, source, key, delta) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  if (source === 'suggestion') {
    mediaEntry.sizeQuantities[key] = Math.max(1, (mediaEntry.sizeQuantities[key] || 1) + delta);
  } else {
    const sizeIndex = Number(key);
    mediaEntry.customSizeQuantities[sizeIndex] = Math.max(
      1,
      (mediaEntry.customSizeQuantities[sizeIndex] || 1) + delta
    );
  }
  renderMediumBlocks();
  autoFillImgSize();
}

function updateCustomSize(mediumName, sizeIndex, value) {
  state.mediaState[mediumName].customSizes[sizeIndex] = value;
  if (hasMediumSize(mediumName)) document.getElementById('f-size-' + cssId(mediumName)).classList.remove('inv');
  autoFillImgSize();
  updateMediumAccordionSummary(mediumName);
}

function updateMediumAccordionSummary(mediumName) {
  const block = document.getElementById('mb-' + cssId(mediumName));
  if (!block) return;
  const summary = block.querySelector('.medium-accordion-status');
  if (!summary) return;
  const entries = getSelectedSizeEntriesForMedium(mediumName);
  const total = entries.reduce((sum, entry) => sum + entry.quantity, 0);
  summary.textContent = entries.length ? `${entries.length}サイズ・${total}枚` : 'サイズ未設定';
  summary.classList.toggle('is-empty', !entries.length);
  summary.classList.toggle('is-set', !!entries.length);
}

function addCustomSize(mediumName) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  mediaEntry.customSizes.push('');
  mediaEntry.customSizeQuantities.push(1);
  renderMediumBlocks();
  const newInput = document.getElementById(`custom-size-${cssId(mediumName)}-${mediaEntry.customSizes.length - 1}`);
  if (newInput) newInput.focus();
}

function removeCustomSize(mediumName, sizeIndex) {
  const mediaEntry = state.mediaState[mediumName];
  ensureMediaEntryQuantities(mediaEntry);
  mediaEntry.customSizes.splice(sizeIndex, 1);
  mediaEntry.customSizeQuantities.splice(sizeIndex, 1);
  if (!mediaEntry.customSizes.length) {
    mediaEntry.customSizes.push('');
    mediaEntry.customSizeQuantities.push(1);
  }
  renderMediumBlocks();
  autoFillImgSize();
}

function hasMediumSize(mediumName) {
  return getSelectedSizeEntriesForMedium(mediumName).some(entry => Number(entry.quantity) > 0);
}

function validateSelectedMediaSizes() {
  let ok = state.selectedMedia.length > 0;
  const mediumField = document.getElementById('f-medium');
  if (mediumField) mediumField.classList.toggle('inv', !state.selectedMedia.length);
  state.selectedMedia.forEach(mediumName => {
    const field = document.getElementById(`f-size-${cssId(mediumName)}`);
    if (!field) return;
    const valid = hasMediumSize(mediumName);
    field.classList.toggle('inv', !valid);
    if (!valid) ok = false;
  });
  return ok;
}

function getMediumDisplayName(mediumName) {
  if (mediumName !== 'その他') return mediumName;
  const otherInput = document.getElementById('inp-medium-other');
  return (otherInput && otherInput.value.trim()) || 'その他媒体';
}

function allSelectedSizesFlat() {
  const flatSizes = [];
  state.selectedMedia.forEach(mediumName => {
    const displayName = getMediumDisplayName(mediumName);
    getSelectedSizeEntriesForMedium(mediumName).forEach(entry => {
      flatSizes.push(`【${displayName}】${formatSizeWithQuantity(entry)}`);
    });
  });
  return flatSizes;
}

function getSelectedSizeEntriesForMedium(mediumName) {
  const mediaEntry = state.mediaState[mediumName];
  if (!mediaEntry) return [];
  ensureMediaEntryQuantities(mediaEntry);
  return [
    ...mediaEntry.selectedSizes.map(sizeLabel => ({
      label: sizeLabel,
      quantity: mediaEntry.sizeQuantities[sizeLabel] || 1,
      sourceType: 'suggestion',
      sourceKey: sizeLabel
    })),
    ...mediaEntry.customSizes
      .map((sizeValue, sizeIndex) => ({
        label: sizeValue.trim(),
        quantity: mediaEntry.customSizeQuantities[sizeIndex] || 1,
        sourceType: 'custom',
        sourceIndex: sizeIndex
      }))
      .filter(entry => entry.label)
  ];
}

function formatSizeWithQuantity(entry) {
  return `${entry.label} × ${entry.quantity}枚`;
}

function getTotalImageCount() {
  return state.selectedMedia.reduce((total, mediumName) => (
    total + getSelectedSizeEntriesForMedium(mediumName)
      .reduce((mediumTotal, entry) => mediumTotal + entry.quantity, 0)
  ), 0);
}

function renderFloatingMediaSummary(visibleStep = currentStep) {
  const panel = document.getElementById('floating-media-summary');
  if (!panel) return;
  const menuToggle = document.getElementById('mobile-summary-menu-toggle');
  const menuCount = document.getElementById('mobile-summary-menu-count');
  const siteHeader = document.querySelector('.site-header');

  const instructionTargets = getInstructionTargets();
  const entries = state.selectedMedia.map(mediumName => ({
    name: getMediumDisplayName(mediumName),
    sizes: instructionTargets.filter(target => target.mediumName === mediumName)
  }));
  const imageCount = entries.reduce((total, entry) => (
    total + entry.sizes.reduce((entryTotal, target) => entryTotal + target.quantity, 0)
  ), 0);
  const shouldShow = visibleStep >= 3 && visibleStep <= totalSteps && entries.length > 0;
  const isInstructionStep = visibleStep === 4 && state.imgCards.length > 0;
  const activeIndex = state.activeInstructionGroup || 0;
  const activeTargetId = state.imgCards[activeIndex]?.targetIds?.[0] || '';

  panel.classList.toggle('is-visible', shouldShow);
  panel.classList.toggle('is-instruction-picker', isInstructionStep);
  menuToggle?.classList.toggle('is-visible', shouldShow);
  siteHeader?.classList.toggle('has-mobile-media-menu', shouldShow);
  if (!shouldShow) {
    closeMobileMediaMenu();
    return;
  }

  const menuItemCount = imageCount;
  if (menuCount) menuCount.textContent = String(menuItemCount);
  if (menuToggle) {
    menuToggle.setAttribute('aria-label', `${isInstructionStep ? '制作画像一覧' : '選択内容'}（${menuItemCount}件）を開く`);
  }

  document.getElementById('floating-media-summary-body').innerHTML = `
    <div class="floating-media-overall">
      <span>${isInstructionStep ? '制作画像を選択' : '選択内容'}</span>
      <strong>${isInstructionStep ? `${imageCount}枚` : `合計 ${imageCount}枚`}</strong>
    </div>
    ${isInstructionStep ? '<div class="floating-media-picker-help">編集する媒体・サイズを選択してください</div>' : ''}
    <div class="floating-media-entry-list">
      ${entries.map(entry => {
        const mediumTotal = entry.sizes.reduce((total, size) => total + size.quantity, 0);
        return `
          <section class="floating-media-entry">
            <div class="floating-media-entry-head">
              <strong>${escHtml(entry.name)}</strong>
              <span>${mediumTotal}枚</span>
            </div>
            <div class="floating-media-size-list">
              ${entry.sizes.length
                ? entry.sizes.map(target => {
                    return `
                    <label class="floating-media-size-row ${isInstructionStep && activeTargetId === target.id ? 'is-active-target' : ''}" data-target-id="${target.id}" ${isInstructionStep ? `onclick="selectInstructionTarget('${target.id}')" role="button" tabindex="0"` : ''}>
                      ${isInstructionStep ? `<i class="floating-media-complete-icon ${isInstructionTargetComplete(target) ? 'is-visible' : ''}" aria-label="入力済み">✓</i>` : ''}
                      <span>${escHtml(target.sizeLabel)}</span>
                      <strong>${target.quantity}枚</strong>
                    </label>`;
                  }).join('')
                : '<div class="floating-media-empty">サイズ未入力</div>'}
            </div>
          </section>`;
      }).join('')}
    </div>`;
}

function setMobileMediaMenuOpen(shouldOpen) {
  const panel = document.getElementById('floating-media-summary');
  const menuToggle = document.getElementById('mobile-summary-menu-toggle');
  const backdrop = document.getElementById('mobile-summary-menu-backdrop');
  if (!panel || !menuToggle || !backdrop) return;

  const canOpen = panel.classList.contains('is-visible') && window.matchMedia('(max-width: 600px)').matches;
  const isOpen = !!shouldOpen && canOpen;
  panel.classList.toggle('is-mobile-open', isOpen);
  menuToggle.classList.toggle('is-open', isOpen);
  menuToggle.setAttribute('aria-expanded', String(isOpen));
  menuToggle.setAttribute('aria-label', isOpen ? '制作画像一覧を閉じる' : '制作画像一覧を開く');
  backdrop.hidden = !isOpen;
  document.body.classList.toggle('mobile-summary-menu-open', isOpen);
}

function toggleMobileMediaMenu() {
  const panel = document.getElementById('floating-media-summary');
  setMobileMediaMenuOpen(!panel?.classList.contains('is-mobile-open'));
}

function closeMobileMediaMenu() {
  setMobileMediaMenuOpen(false);
}

function autoFillImgSize() {
  const imgSizeTextarea = document.getElementById('inp-imgsize');
  const summary = allSelectedSizesFlat();
  imgSizeTextarea.value = summary.join(' / ');
  const count = getTotalImageCount();
  const countInput = document.getElementById('inp-count');
  state.count = count;
  countInput.value = count || '';
  renderFloatingMediaSummary();
}

/* ========== STEP 4: デザイン指示 ========== */
function getMoodGroupOptions(group) {
  return group.sections ? group.sections.flatMap(section => section.options) : group.options;
}

function isMoodOptionDisabled(card, group, moodLabel) {
  if (!group.maxSelections || card.moods.includes(moodLabel)) return false;
  const selectedCount = card.moods.filter(mood => getMoodGroupOptions(group).includes(mood)).length;
  return selectedCount >= group.maxSelections;
}

function initMoodTagsInto(containerId, cardObj, prefix) {
  const tagsWrap = document.getElementById(containerId);
  if (!tagsWrap) return;
  const renderMoodSections = group => `
    ${(group.sections || [{ label: '', options: group.options }]).map(section => `
        <div class="mood-section">
          ${section.label ? `<div class="mood-section-label">${section.label}</div>` : ''}
          <div class="mood-options">
            ${section.options.map(moodLabel => {
              const isSelected = cardObj.moods.includes(moodLabel);
              const isDisabled = isMoodOptionDisabled(cardObj, group, moodLabel);
              return `
              <label class="${isSelected ? 'chk' : ''}${isDisabled ? ' is-disabled' : ''}" data-mood="${escAttr(moodLabel)}" data-mood-group="${group.key}" aria-disabled="${isDisabled}" onclick="toggleCardMood('${prefix}','${escJs(moodLabel)}',this)">
                <input type="checkbox" ${isSelected ? 'checked' : ''} ${isDisabled ? 'disabled' : ''}>${moodLabel}
              </label>`;
            }).join('')}
          </div>
        </div>`).join('')}`;
  const renderOtherInput = (key, label) => `
    <div class="mood-other-field">
      <div class="mood-section-label">その他</div>
      <input type="text" value="${escAttr(cardObj[key])}" placeholder="自由にご記入ください" aria-label="${label}のその他" oninput="updateCardField('${prefix}','${key}',this.value)">
    </div>`;
  const renderMoodGroup = group => group.collapsible ? `
    <details class="mood-collapsible" ${cardObj[group.openKey] ? 'open' : ''} ontoggle="setMoodGroupOpen('${prefix}','${group.openKey}',this.open)">
      <summary><span>${group.label}</span><span class="opt">${group.hint}</span></summary>
      <div class="mood-collapsible-body">${renderMoodSections(group)}${group.key === 'worldview' ? renderOtherInput('worldviewOther', group.label) : ''}</div>
    </details>` : `
    <div class="mood-group">
      <div class="mood-group-label">${group.label}</div>
      <div class="mood-group-hint">${group.hint}</div>
      ${renderMoodSections(group)}
    </div>`;
  tagsWrap.innerHTML = renderMoodGroup(moodGroups[0]) +
    renderOtherInput('atmosphereOther', '雰囲気') +
    moodGroups.slice(1).map(renderMoodGroup).join('');
}

function normalizeCardDetails(card) {
  if (!card) return card;
  card.moods = Array.isArray(card.moods) ? card.moods : [];
  card.personFiles = Array.isArray(card.personFiles) ? card.personFiles : [];
  card.refFiles = Array.isArray(card.refFiles) ? card.refFiles : [];
  card.assetFiles = Array.isArray(card.assetFiles) ? card.assetFiles : [];

  if (!card.assetNote) {
    card.assetNote = [card.personFreeNote, card.refNote].filter(Boolean).join('\n');
  }
  card.personFreeNote = '';
  card.refNote = '';
  const legacyInstruction = splitLegacyInstructionText(card.designTxt);
  if (!card.copyTxt && legacyInstruction.copyTxt) card.copyTxt = legacyInstruction.copyTxt;
  card.designTxt = legacyInstruction.designTxt || stripLegacyDesignInstructionTemplate(card.designTxt);

  const legacyColors = card.moods.map(normalizeColorName).filter(Boolean);
  card.baseColor = normalizeColorName(card.baseColor);
  card.mainColor = normalizeColorName(card.mainColor);
  card.accentColor = normalizeColorName(card.accentColor);
  if (!card.baseColor) card.baseColor = legacyColors[0] || '';
  if (!card.mainColor) card.mainColor = legacyColors[1] || '';
  if (!card.accentColor) card.accentColor = legacyColors[2] || '';
  card.colorChoice = normalizeColorName(card.colorChoice) || normalizeColorName(card.mainColor) || normalizeColorName(card.baseColor) || '';
  if (!COLOR_OPTIONS.includes(card.colorChoice)) card.colorChoice = '';
  card.colorOther = card.colorOther || '';
  card.colorOtherByRole = card.colorOtherByRole && typeof card.colorOtherByRole === 'object'
    ? card.colorOtherByRole : {};
  if (card.colorOther && !card.colorOtherByRole.main) card.colorOtherByRole.main = card.colorOther;
  if (!card.baseColorCode && card.baseColor) card.baseColorCode = COLOR_PRESET_CODES[card.baseColor] || '';
  if (!card.mainColorCode && card.mainColor) card.mainColorCode = COLOR_PRESET_CODES[card.mainColor] || '';
  if (!card.accentColorCode && card.accentColor) card.accentColorCode = COLOR_PRESET_CODES[card.accentColor] || '';
  card.colorNote = card.colorNote || '';
  if (!card.atmosphereOther && card.moodFreeNote) {
    card.atmosphereOther = card.moodFreeNote;
  }
  if (!card.atmosphereOther && card.moodNotes && typeof card.moodNotes === 'object') {
    card.atmosphereOther = [card.moodNotes.elegant, card.moodNotes.friendly, card.moodNotes.sharp].filter(Boolean).join(' / ');
  }
  if (!card.worldviewOther && card.moodNotes?.worldview) card.worldviewOther = card.moodNotes.worldview;
  card.atmosphereOther = card.atmosphereOther || '';
  card.worldviewOther = card.worldviewOther || '';
  card.worldviewOpen = !!card.worldviewOpen;
  delete card.moodNotes;
  delete card.moodFreeNote;
  delete card.seasonOpen;
  delete card.words;
  delete card.highlight;
  card.moods = card.moods.filter(mood => VALID_MOOD_OPTIONS.includes(mood));
  let atmosphereCount = 0;
  card.moods = card.moods.filter(mood => {
    if (ATMOSPHERE_OPTIONS.includes(mood)) {
      atmosphereCount += 1;
      return atmosphereCount <= 2;
    }
    return true;
  });
  delete card.infoDensity;
  return card;
}

function renderColorOptions(selectedColor) {
  return '<option value="">指定なし</option>' +
    COLOR_OPTIONS.map(color =>
      `<option value="${escAttr(color)}" ${color === selectedColor ? 'selected' : ''}>${escHtml(color)}</option>`
    ).join('');
}

function normalizeColorCode(value) {
  const colorCode = String(value || '').trim();
  if (/^#[0-9a-f]{6}$/i.test(colorCode)) return colorCode.toUpperCase();
  if (/^#[0-9a-f]{3}$/i.test(colorCode)) {
    return `#${colorCode.slice(1).split('').map(char => char + char).join('')}`.toUpperCase();
  }
  return '';
}

function getColorPickerValue(card, colorKey, codeKey) {
  return normalizeColorCode(card[codeKey]) || COLOR_PRESET_CODES[card[colorKey]] || '#FFFFFF';
}

function getCard(prefix) {
  if (prefix === 'common') return state.common;
  const cardIndex = parseInt(prefix.split('-')[1]);
  return state.imgCards[cardIndex];
}

function toggleCardMood(prefix, moodLabel, el) {
  // ネイティブのチェックボックス状態反映を待ってから状態を読み取る
  setTimeout(() => {
    const card = getCard(prefix);
    const input = el.querySelector('input');
    if (input.disabled) return;
    const isChecked = input.checked;
    const group = moodGroups.find(item => getMoodGroupOptions(item).includes(moodLabel));
    if (isChecked && group && isMoodOptionDisabled(card, group, moodLabel)) {
      input.checked = false;
      el.classList.remove('chk');
      return;
    }
    el.classList.toggle('chk', isChecked);
    if (isChecked) { if (!card.moods.includes(moodLabel)) card.moods.push(moodLabel); }
    else { card.moods = card.moods.filter(x => x !== moodLabel); }
    refreshMoodOptionAvailability(prefix);
    refreshInstructionCompletionIndicators();
  }, 10);
}

function refreshMoodOptionAvailability(prefix) {
  const card = getCard(prefix);
  const container = document.getElementById(`moodtags-${prefix}`);
  if (!container || !card) return;
  container.querySelectorAll('label[data-mood]').forEach(label => {
    const moodLabel = label.dataset.mood;
    const group = moodGroups.find(item => item.key === label.dataset.moodGroup);
    const isDisabled = group ? isMoodOptionDisabled(card, group, moodLabel) : false;
    const input = label.querySelector('input');
    input.disabled = isDisabled;
    label.classList.toggle('is-disabled', isDisabled);
    label.setAttribute('aria-disabled', String(isDisabled));
  });
}

function setMoodGroupOpen(prefix, key, isOpen) {
  const card = getCard(prefix);
  if (card) card[key] = isOpen;
}

/* 共通／個別カードのフルテンプレートをHTML文字列で生成 */
function renderCardTemplate(prefix, card, opts) {
  opts = opts || {};
  normalizeCardDetails(card);
  const heading = opts.heading || '';
  const isIndividual = !!opts.individual;
  const canRemove = isIndividual && !!opts.canRemove;
  const idx = opts.idx != null ? opts.idx : '';
  const collapsed = isIndividual && !!card.collapsed;
  const personUsage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
  const currentTargetId = card.targetIds?.[0];
  const currentTarget = prefix.startsWith('card-')
    ? getInstructionTargets().find(target => target.id === currentTargetId)
    : null;
  const currentTargetLabel = currentTarget
    ? `${currentTarget.displayName}／${currentTarget.sizeLabel}`
    : '同じ媒体・サイズ';
  const sameTargetRemaining = prefix.startsWith('card-')
    ? state.imgCards.filter(item => item !== card && item.targetIds?.[0] === currentTargetId).length
    : 0;
  const unenteredRemaining = prefix.startsWith('card-')
    ? state.imgCards.filter(item => item !== card && !cardHasAnyInput(item)).length
    : 0;
  const canCopyInstruction = state.imgCards.length > 1 && !card.sameAsCardKey && hasRequiredInstruction(card);
  return `
    ${heading ? `
      <div class="img-card-head">
        <div class="img-card-num">${opts.num || ''}</div>
        <div class="img-card-label">${heading}</div>
        ${collapsed && card.targetImage ? `<div class="img-card-tag">${escHtml(card.targetImage)}</div>` : ''}
        ${isIndividual ? `<div class="img-card-toggle" onclick="toggleImgCard(${idx})"><i class="ti ti-chevron-${collapsed ? 'down' : 'up'}"></i> ${collapsed ? '開く' : '閉じる'}</div>` : ''}
        ${canRemove ? `<div class="img-card-remove" onclick="removeImgCard(${idx})"><i class="ti ti-trash"></i> 削除</div>` : ''}
      </div>
      <div class="img-card-body${collapsed ? '' : ' open'}">` : ''}
    ${isIndividual ? `
    <div class="field">
      <div class="lbl">対象画像 <span class="req">必須</span></div>
      <input type="text" class="control-w-md" placeholder="例：メイン画像・700×300 / 全画像共通" value="${escAttr(card.targetImage)}" oninput="updateCardField('${prefix}','targetImage',this.value)">
      <div class="hint">どの画像・サイズへの指示かを明記してください（例：メイン、バナー700×300）</div>
    </div>` : ''}
    <div class="field" id="f-person-${prefix}">
      <div class="person-photo-question-row">
        <div class="lbl">人物写真を使用しますか <span class="req">必須</span></div>
        <div class="radios person-photo-modes">
          <div class="rbtn ${personUsage === '使用する' ? 'sel' : ''}" onclick="setPersonUsage('${prefix}','使用する')">使用する</div>
          <div class="rbtn ${personUsage === '使用しない' ? 'sel' : ''}" onclick="setPersonUsage('${prefix}','使用しない')">使用しない</div>
        </div>
      </div>
      <div class="person-staff-photo-option" style="display:${personUsage === '使用する' ? 'block' : 'none'}">
        <label class="person-staff-photo-check">
          <input type="checkbox" ${card.staffPhotoAllowed ? 'checked' : ''} onchange="updateCardField('${prefix}','staffPhotoAllowed',this.checked)">
          <span>在籍写真の使用【可能】</span>
        </label>
      </div>
      <div class="err">人物写真を使用するか選択してください</div>
    </div>

    <div class="field attachment-field person-material-field" style="display:${personUsage === '使用する' || (card.personFiles || []).length ? 'block' : 'none'}">
      <div class="lbl">人物素材 <span class="opt">任意</span></div>
      <div class="hint">デザイン内で使用する人物画像を添付してください</div>
      <div class="upload-box small" onclick="document.getElementById('pf-${prefix}').click()" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handlePersonFileDrop(event,'${prefix}')">
        <svg class="upload-icon upload-icon-prominent" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M21.5 50H16a14 14 0 1 1 3.2-27.6A17.5 17.5 0 0 1 52.4 29 12 12 0 0 1 48 52H42"></path>
          <path d="M32 51V25"></path>
          <path d="m22 35 10-10 10 10"></path>
        </svg>
        <div class="upload-main">人物素材をクリックまたはドラッグ＆ドロップ</div>
        <div class="upload-sub">PNG / JPG / WEBP / ZIP など・各20MBまで</div>
      </div>
      <input type="file" id="pf-${prefix}" multiple accept="${PERSON_FILE_ACCEPT}" style="display:none" onchange="handlePersonFiles('${prefix}',this)">
      <div class="flist" id="pf-list-${prefix}"></div>
      <div class="err upload-error" id="pf-error-${prefix}"></div>
    </div>

    <div class="field attachment-field reference-image-field">
      <div class="lbl">参考画像 <span class="opt">任意</span></div>
      <div class="hint">デザインや雰囲気の参考となる画像を添付してください</div>
      <div class="upload-box small" onclick="document.getElementById('rf-${prefix}').click()" ondragover="handleUploadDragOver(event)" ondragleave="handleUploadDragLeave(event)" ondrop="handleRefFileDrop(event,'${prefix}')">
        <svg class="upload-icon upload-icon-prominent" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">
          <path d="M21.5 50H16a14 14 0 1 1 3.2-27.6A17.5 17.5 0 0 1 52.4 29 12 12 0 0 1 48 52H42"></path>
          <path d="M32 51V25"></path>
          <path d="m22 35 10-10 10 10"></path>
        </svg>
        <div class="upload-main">参考画像をクリックまたはドラッグ＆ドロップ</div>
        <div class="upload-sub">画像 / Excel / PDF / ZIP など・各20MBまで</div>
      </div>
      <input type="file" id="rf-${prefix}" multiple accept="${REFERENCE_FILE_ACCEPT}" style="display:none" onchange="handleRefFiles('${prefix}',this)">
      <div class="flist" id="rf-list-${prefix}"></div>
      <div class="err upload-error" id="rf-error-${prefix}"></div>
    </div>

    <div class="field file-share-url-field">
      <div class="lbl">ファイル共有URL <span class="opt">任意</span></div>
      <div class="hint">ギガファイル便、Googleドライブ、共有ドライブの共有リンクを入力してください。複数ある場合は改行してください。</div>
      <div class="file-share-url-row">
        <input type="url" id="fs-${prefix}" class="control-w-lg file-share-url-input" placeholder="https://" value="${escAttr(card.fileShareUrl || '')}" oninput="updateCardField('${prefix}','fileShareUrl',this.value)">
        <button type="button" class="btn file-share-open-button" onclick="window.open('https://gigafile.nu/','_blank','noopener,noreferrer')">ギガファイル便を開く</button>
      </div>
    </div>

    <div class="field" id="f-designtxt-${prefix}">
      <div class="instruction-text-split">
        <div class="instruction-text-part">
          <div class="lbl">掲載文言 <span class="opt">任意</span></div>
          <textarea class="control-w-lg design-instruction-textarea" placeholder="例）○○月限定イベント&#10;ご新規様、会員様どちらも&#10;特別コースフリー　○○分○○○○円！&#10;※必ず受付時に〇〇月限定イベント見たとお伝えください。&#10;※他イベントとの併用はできません。" oninput="updateInstructionText('${prefix}','copyTxt',this.value,this)">${escHtml(card.copyTxt || '')}</textarea>
        </div>
        <div class="instruction-text-part">
          <div class="lbl design-label-row">デザイン指示 <span class="opt">任意</span><button type="button" class="all-omakase-button ${card.allOmakase ? 'is-active' : ''}" onclick="setAllOmakase('${prefix}')">${card.allOmakase ? 'おまかせ（選択中）' : 'おまかせ'}</button></div>
          <textarea class="control-w-lg design-instruction-textarea" placeholder="例）デザイン：参考画像①&#10;色合い：参考画像②&#10;フォント：丸みのある可愛らしいフォント&#10;人物：添付の女性2名を使用してください。" oninput="updateInstructionText('${prefix}','designTxt',this.value,this)">${escHtml(card.designTxt || '')}</textarea>
          ${card.allOmakase ? '<p class="omakase-disclaimer">※おまかせの場合、作成後の要望・修正は追加料金が発生しますので予めご了承ください。</p>' : ''}
        </div>
      </div>
      <div class="err">デザイン指示を入力するか、「おまかせ」を選択してください</div>
    </div>
    <details class="advanced-instructions" ${card.advancedOpen ? 'open' : ''} ontoggle="setAdvancedInstructionsOpen('${prefix}',this.open)">
      <summary><span>詳しい指示を設定する</span><span class="opt">任意</span></summary>
      <div class="advanced-instructions-body">
        <div class="advanced-instructions-toolbar">
          <span>カラー・雰囲気・デザイン要素の詳細設定</span>
          <button type="button" onclick="resetAdvancedInstructions('${prefix}')"><i class="ti ti-restore"></i>詳細設定をリセット</button>
        </div>
        <div class="lbl">カラーの方向性 <span class="opt">任意</span></div>
        <div class="color-role-list">
          ${COLOR_ROLE_CONFIG.map(role => {
            const roleValue = getColorRoleValue(card, role.key);
            const roleOther = getColorRoleOther(card, role.key);
            const codeKey = role.key === 'sub' ? 'baseColorCode' : role.key === 'accent' ? 'accentColorCode' : 'mainColorCode';
            const roleCode = normalizeColorCode(card[codeKey]) || COLOR_PRESET_CODES[roleValue] || '';
            const pickerValue = roleCode || '#FFFFFF';
            const roleMarkup = `<div class="color-role-field">
              <div class="color-role-heading"><strong>${role.label}</strong><span class="opt">${role.hint}</span></div>
              <div class="color-picker-code-row">
                <label class="color-picker-control">色見本
                  <input type="color" id="${codeKey}-picker-${prefix}" value="${pickerValue}" aria-label="${role.label}の色見本" oninput="setColorPicker('${prefix}','${codeKey}',this.value)">
                </label>
                <label class="color-code-control">カラーコード
                  <input type="text" id="${codeKey}-code-${prefix}" class="color-code-input" value="${escAttr(roleCode)}" placeholder="#RRGGBB" inputmode="text" maxlength="7" oninput="updateColorCode('${prefix}','${codeKey}',this.value)">
                </label>
              </div>
            </div>`;
            return roleMarkup;
          }).join('')}
        </div>
        <div class="color-direction-hint">
          指定した色を参考に、制作側で全体のバランスに合わせて色を選定する場合があります。
        </div>
        <div class="color-direction-note">
          <div class="lbl">カラーについての補足 <span class="opt">任意</span></div>
          <textarea class="control-w-md color-note-textarea" rows="2" placeholder="例：全体は落ち着いた色味、赤は使用しない、指定色に近い範囲で調整可能など" oninput="updateCardField('${prefix}','colorNote',this.value)">${escHtml(card.colorNote)}</textarea>
        </div>
        <div class="advanced-instructions-divider"></div>
        <div class="tag-chk" id="moodtags-${prefix}"></div>
      </div>
    </details>
    ${prefix.startsWith('card-') ? `
      <div class="instruction-apply-all-footer">
        <div class="instruction-reset-actions">
          <button type="button" class="instruction-reset-card instruction-reset-card-footer" onclick="resetCurrentInstructionCard()">
            この画像の指示をリセット
          </button>
        </div>
        <details class="instruction-copy-menu">
          <summary class="instruction-apply-all ${canCopyInstruction ? '' : 'is-disabled'}" ${canCopyInstruction ? '' : 'onclick="event.preventDefault()"'} title="${canCopyInstruction ? 'コピー先を選択' : 'この画像の必須項目を入力すると使用できます'}">
            <span class="copy-action-icon" aria-hidden="true"></span>
            コピー先を選ぶ
            <span class="instruction-copy-chevron" aria-hidden="true">⌄</span>
          </summary>
          <div class="instruction-copy-options">
            ${sameTargetRemaining > 0 ? `
              <button type="button" onclick="applyInstructionToCurrentTarget()">
                <strong>同じサイズの残り${sameTargetRemaining}枚にコピー</strong>
                <small>${escHtml(currentTargetLabel)}のみ</small>
              </button>` : ''}
            <button type="button" onclick="applyInstructionToUnenteredImages()" ${unenteredRemaining ? '' : 'disabled'}>
              <strong>すべての未入力画像にコピー${unenteredRemaining ? `（${unenteredRemaining}枚）` : ''}</strong>
              <small>${unenteredRemaining ? '媒体・サイズを問わずコピーします。入力済みの画像は変更しません' : '未入力の制作画像はありません'}</small>
            </button>
          </div>
        </details>
      </div>` : ''}
    ${heading ? `</div>` : ''}
  `;
}

function renderCommonBlock() {
  const commonBlockWrap = document.querySelector('#common-instructions-wrap .design-instruction-block');
  commonBlockWrap.innerHTML = renderCardTemplate('common', state.common);
  initMoodTagsInto('moodtags-common', state.common, 'common');
  renderCardFileLists('common', state.common);
}

function setPersonUsage(prefix, usage) {
  const card = getCard(prefix);
  if (!card) return;
  card.personUsage = usage;
  card.allOmakase = false;
  card.person = usage === '使用する' ? '人物写真を使用する' : '使用しない';
  rerenderDesignInstructions();
}

function updatePersonPhotoField(prefix, key, value) {
  const card = getCard(prefix);
  card[key] = value;
  if (card.person) document.getElementById(`f-person-${prefix}`).classList.remove('inv');
}

function rerenderDesignInstructions() {
  if (state.imgMode === 'images' && state.imgCards.length) renderInstructionGroups();
  else renderCommonBlock();
}

function renderCardFileLists(prefix, card) {
  normalizeCardDetails(card);
  renderFileTags(`pf-list-${prefix}`, card.personFiles, (i) => removeCardFile(prefix, 'personFiles', i, `pf-list-${prefix}`));
  renderFileTags(`rf-list-${prefix}`, card.refFiles, (i) => removeCardFile(prefix, 'refFiles', i, `rf-list-${prefix}`));
  renderFileTags(`af-list-${prefix}`, card.assetFiles, (i) => removeCardFile(prefix, 'assetFiles', i, `af-list-${prefix}`));
}

function setCardDesign(prefix, value, el) {
  const card = getCard(prefix);
  card.design = value;
  document.querySelectorAll(`#f-design-${prefix} .radios .rbtn`).forEach(btn => btn.classList.remove('sel'));
  el.classList.add('sel');
  document.getElementById(`ref-block-${prefix}`).style.display = value === '参考画像あり' ? 'block' : 'none';
  document.getElementById(`f-design-${prefix}`).classList.remove('inv');
  const designTxtEl = document.querySelector(`#f-designtxt-${prefix} textarea`);
  if (value === 'おまかせ') {
    card.designTxt = `${DESIGN_INSTRUCTION_TEMPLATE}おまかせ`;
    designTxtEl.value = card.designTxt;
    document.getElementById(`f-designtxt-${prefix}`).classList.remove('inv');
  } else if (designTxtEl.value === `${DESIGN_INSTRUCTION_TEMPLATE}おまかせ`) {
    card.designTxt = DESIGN_INSTRUCTION_TEMPLATE;
    designTxtEl.value = DESIGN_INSTRUCTION_TEMPLATE;
  }
}

function updateCardField(prefix, key, value) {
  getCard(prefix)[key] = value;
  refreshInstructionCompletionIndicators();
}

function updateDesignInstruction(prefix, value, element) {
  updateInstructionText(prefix, 'designTxt', value, element);
}

function updateInstructionText(prefix, key, value, element) {
  const card = getCard(prefix);
  if (!card) return;
  const nextValue = ensureDesignInstructionTemplate(value);
  card[key] = nextValue;
  card.allOmakase = false;
  if (key === 'designTxt' && nextValue.trim()) card.design = '';
  if (element.value !== nextValue) {
    element.value = nextValue;
    element.setSelectionRange(nextValue.length, nextValue.length);
  }
  document.getElementById(`f-designtxt-${prefix}`)?.classList.remove('inv');
  if (instructionNotice) {
    instructionNotice = '';
    document.querySelector('.instruction-inline-notice')?.remove();
  }
  refreshInstructionCompletionIndicators();
}

function setDesignOmakase(prefix) {
  const card = getCard(prefix);
  if (!card) return;
  card.design = card.design === 'おまかせ' ? '' : 'おまかせ';
  card.allOmakase = false;
  card.designTxt = card.design === 'おまかせ' ? 'おまかせ' : '';
  rerenderDesignInstructions();
  saveDraft();
}

function setAllOmakase(prefix) {
  const card = getCard(prefix);
  if (!card) return;
  card.allOmakase = !card.allOmakase;
  if (card.allOmakase) {
    card.person = '';
    card.staffPhotoAllowed = false;
    card.design = 'おまかせ';
    card.designTxt = 'おまかせ';
  } else {
    card.personUsage = '';
    card.design = '';
    card.designTxt = '';
  }
  rerenderDesignInstructions();
  saveDraft();
}

function setColorPreset(prefix, colorKey, codeKey, colorName) {
  const card = getCard(prefix);
  card[colorKey] = colorName;
  card[codeKey] = colorName ? (COLOR_PRESET_CODES[colorName] || '') : '';
  const picker = document.getElementById(`${codeKey}-picker-${prefix}`);
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  if (picker) picker.value = card[codeKey] || '#FFFFFF';
  if (codeInput) {
    codeInput.value = card[codeKey];
    codeInput.classList.remove('invalid');
  }
  refreshInstructionCompletionIndicators();
}

function setColorPicker(prefix, codeKey, value) {
  const colorCode = normalizeColorCode(value);
  const card = getCard(prefix);
  if (!card) return;
  card[codeKey] = colorCode;
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  if (codeInput) {
    codeInput.value = colorCode;
    codeInput.classList.remove('invalid');
  }
  refreshInstructionCompletionIndicators();
  saveDraft();
}

function updateColorCode(prefix, codeKey, value) {
  const card = getCard(prefix);
  if (!card) return;
  const colorCode = normalizeColorCode(value);
  card[codeKey] = colorCode || value.trim().toUpperCase();
  const codeInput = document.getElementById(`${codeKey}-code-${prefix}`);
  const picker = document.getElementById(`${codeKey}-picker-${prefix}`);
  if (codeInput) codeInput.classList.toggle('invalid', !!value && !colorCode);
  if (picker && colorCode) picker.value = colorCode;
  refreshInstructionCompletionIndicators();
  saveDraft();
}

function setAdvancedInstructionsOpen(prefix, isOpen) {
  const card = getCard(prefix);
  if (card) card.advancedOpen = isOpen;
}

function resetAdvancedInstructions(prefix) {
  const card = getCard(prefix);
  if (!card || !window.confirm('詳しい指示の設定をすべてリセットしますか？')) return;
  card.baseColor = '';
  card.mainColor = '';
  card.accentColor = '';
  card.baseColorCode = '';
  card.mainColorCode = '';
  card.accentColorCode = '';
  card.colorChoice = '';
  card.colorOther = '';
  card.colorOtherByRole = {};
  card.colorNote = '';
  card.moods = [];
  card.atmosphereOther = '';
  card.worldviewOther = '';
  card.worldviewOpen = false;
  card.advancedOpen = true;
  renderInstructionGroups();
  saveDraft();
}

function handlePersonFiles(prefix, inp) {
  addPersonFiles(prefix, inp.files);
  inp.value = '';
}

function addPersonFiles(prefix, files) {
  const card = getCard(prefix);
  const errorEl = document.getElementById(`pf-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!PERSON_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.personFiles.find(existingFile => existingFile.name === file.name)) card.personFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  if (card.personFiles.length) {
    card.personUsage = '使用する';
    card.person = '人物写真を使用する';
    document.getElementById(`f-person-${prefix}`).classList.remove('inv');
  }
  renderFileTags(`pf-list-${prefix}`, card.personFiles, (i) => removeCardFile(prefix, 'personFiles', i, `pf-list-${prefix}`));
}

function handleRefFiles(prefix, inp) {
  addRefFiles(prefix, inp.files);
  inp.value = '';
}

function handleAssetFiles(prefix, inp) {
  addAssetFiles(prefix, inp.files);
  inp.value = '';
}

function handleBulkAssetFiles(input) {
  addBulkAssetFiles(input.files);
  input.value = '';
}

function addBulkAssetFiles(files) {
  state.bulkAssetFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
  const errorEl = document.getElementById('bulk-asset-error');
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!state.bulkAssetFiles.find(existingFile => existingFile.name === file.name)) {
      state.bulkAssetFiles.push(file);
    }
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderBulkAssetFiles();
}

function handleBulkAssetFileDrop(event) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addBulkAssetFiles(event.dataTransfer.files);
}

function removeBulkAssetFile(index) {
  const [removedFile] = state.bulkAssetFiles.splice(index, 1);
  const previewUrl = removedFile ? filePreviewUrls.get(removedFile) : '';
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    filePreviewUrls.delete(removedFile);
  }
  renderBulkAssetFiles();
}

function renderBulkAssetFiles() {
  state.bulkAssetFiles = Array.isArray(state.bulkAssetFiles) ? state.bulkAssetFiles : [];
  renderFileTags('bulk-asset-file-list', state.bulkAssetFiles, removeBulkAssetFile);
}

function addAssetFiles(prefix, files) {
  const card = normalizeCardDetails(getCard(prefix));
  const errorEl = document.getElementById(`af-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.assetFiles.find(existingFile => existingFile.name === file.name)) card.assetFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderFileTags(`af-list-${prefix}`, card.assetFiles, (i) => removeCardFile(prefix, 'assetFiles', i, `af-list-${prefix}`));
}

function addRefFiles(prefix, files) {
  const card = getCard(prefix);
  const errorEl = document.getElementById(`rf-error-${prefix}`);
  const errors = [];
  Array.from(files || []).forEach(file => {
    const extension = file.name.split('.').pop().toLowerCase();
    if (!REFERENCE_FILE_EXTENSIONS.includes(extension)) errors.push(`${file.name}：対応していない形式です`);
    else if (file.size > MAX_REFERENCE_FILE_SIZE) errors.push(`${file.name}：20MBを超えています`);
    else if (!card.refFiles.find(existingFile => existingFile.name === file.name)) card.refFiles.push(file);
  });
  errorEl.textContent = errors.join(' / ');
  errorEl.style.display = errors.length ? 'block' : 'none';
  renderFileTags(`rf-list-${prefix}`, card.refFiles, (i) => removeCardFile(prefix, 'refFiles', i, `rf-list-${prefix}`));
}

function handleUploadDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  event.currentTarget.classList.add('is-dragover');
}

function handleUploadDragLeave(event) {
  event.currentTarget.classList.remove('is-dragover');
}

function handlePersonFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addPersonFiles(prefix, event.dataTransfer.files);
}

function handleRefFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addRefFiles(prefix, event.dataTransfer.files);
}

function handleAssetFileDrop(event, prefix) {
  event.preventDefault();
  event.currentTarget.classList.remove('is-dragover');
  addAssetFiles(prefix, event.dataTransfer.files);
}

function removeCardFile(prefix, key, i, listId) {
  const card = getCard(prefix);
  const [removedFile] = card[key].splice(i, 1);
  const previewUrl = removedFile ? filePreviewUrls.get(removedFile) : '';
  if (previewUrl) {
    URL.revokeObjectURL(previewUrl);
    filePreviewUrls.delete(removedFile);
  }
  renderFileTags(listId, card[key], (j) => removeCardFile(prefix, key, j, listId));
}

function getFilePreviewUrl(file) {
  const extension = (file?.name || '').split('.').pop().toLowerCase();
  if (!file || !PREVIEWABLE_IMAGE_EXTENSIONS.includes(extension)) return '';
  if (!filePreviewUrls.has(file)) filePreviewUrls.set(file, URL.createObjectURL(file));
  return filePreviewUrls.get(file);
}

function getFileIconClass(file) {
  const extension = (file?.name || '').split('.').pop().toLowerCase();
  if (extension === 'pdf') return 'ti-file-type-pdf';
  if (extension === 'txt') return 'ti-file-text';
  if (ARCHIVE_FILE_EXTENSIONS.includes(extension)) return 'ti-file-zip';
  return 'ti-file';
}

function renderFileTags(listId, files, onRemove) {
  const listEl = document.getElementById(listId);
  if (!listEl) return;
  listEl.innerHTML = files.map((file, i) => {
    const previewUrl = getFilePreviewUrl(file);
    return `
      <div class="file-preview-card">
        <div class="file-preview-thumb">
          ${previewUrl
            ? `<img src="${escAttr(previewUrl)}" alt="${escAttr(file.name)}">`
            : `<i class="ti ${getFileIconClass(file)}"></i>`}
        </div>
        <button type="button" class="file-preview-remove" data-i="${i}" aria-label="${escAttr(file.name)}を削除">×</button>
        <div class="file-preview-name" title="${escAttr(file.name)}">${escHtml(file.name)}</div>
        <div class="file-preview-size">${(file.size / 1024 / 1024).toFixed(1)}MB</div>
      </div>`;
  }).join('');
  listEl.querySelectorAll('.file-preview-remove').forEach(button => {
    button.addEventListener('click', event => {
      event.stopPropagation();
      onRemove(parseInt(button.dataset.i));
    });
  });
}

/* 媒体・サイズごとに制作画像の指示カードを管理 */
function getInstructionTargets() {
  const targets = [];
  state.selectedMedia.forEach((mediumName, mediumIndex) => {
    getSelectedSizeEntriesForMedium(mediumName).forEach((entry, sizeIndex) => {
      targets.push({
        id: `target-${mediumIndex}-${sizeIndex}`,
        mediumName,
        displayName: getMediumDisplayName(mediumName),
        sizeLabel: entry.label,
        quantity: entry.quantity,
        sourceType: entry.sourceType,
        sourceKey: entry.sourceKey,
        sourceIndex: entry.sourceIndex
      });
    });
  });
  return targets;
}

function cardHasInstruction(card) {
  normalizeCardDetails(card);
  return !!(card.personUsage || card.design || hasDesignInstructionContent(card.copyTxt) || hasDesignInstructionContent(card.designTxt) || card.assetNote || card.fileShareUrl ||
    card.moods.length || card.atmosphereOther || card.worldviewOther || card.baseColor ||
    card.mainColor || card.accentColor || card.baseColorCode || card.mainColorCode ||
    card.accentColorCode || card.colorNote || card.sameAsCardKey);
}

function cloneInstructionCard(card) {
  const clonedCard = {
    ...makeBlankCard(),
    ...(card || {}),
    personFiles: card?.personFiles || [],
    refFiles: card?.refFiles || [],
    assetFiles: card?.assetFiles || []
  };
  return normalizeCardDetails(clonedCard);
}

function getInstructionCardKey(card) {
  return `${card?.targetIds?.[0] || ''}::${Number(card?.imageNumber) || 1}`;
}

function findInstructionCardByKey(cardKey) {
  return state.imgCards.find(card => getInstructionCardKey(card) === cardKey);
}

function resolveInstructionCard(card, visitedKeys = new Set()) {
  if (!card) return null;
  const cardKey = getInstructionCardKey(card);
  if (visitedKeys.has(cardKey)) return null;
  if (!card.sameAsCardKey) return card;
  visitedKeys.add(cardKey);
  return resolveInstructionCard(findInstructionCardByKey(card.sameAsCardKey), visitedKeys);
}

function hasRequiredInstruction(card) {
  const effectiveCard = resolveInstructionCard(card);
  if (!effectiveCard) return false;
  const usage = effectiveCard.personUsage ||
    (effectiveCard.person === '使用しない' ? '使用しない' : (effectiveCard.person ? '使用する' : ''));
  return !!(usage && hasDesignInstructionContent(effectiveCard.designTxt));
}

function isInstructionTargetComplete(target) {
  if (!target) return false;
  const targetCards = state.imgCards
    .filter(card => card.targetIds?.[0] === target.id)
    .sort((a, b) => (Number(a.imageNumber) || 1) - (Number(b.imageNumber) || 1));
  return targetCards.length >= target.quantity &&
    targetCards.slice(0, target.quantity).every(hasRequiredInstruction);
}

function refreshInstructionCompletionIndicators() {
  const completionByTargetId = new Map(
    getInstructionTargets().map(target => [target.id, isInstructionTargetComplete(target)])
  );
  document.querySelectorAll('[data-target-id]').forEach(element => {
    const isComplete = !!completionByTargetId.get(element.dataset.targetId);
    element.classList.toggle('is-complete', isComplete);
    const icon = element.querySelector('.instruction-complete-icon, .floating-media-complete-icon');
    icon?.classList.toggle('is-visible', isComplete);
  });
  const applyAllButton = document.querySelector('.instruction-apply-all');
  const activeCard = state.imgCards[state.activeInstructionGroup];
  if (applyAllButton && activeCard) {
    const canApplyToAll = state.imgCards.length > 1 &&
      !activeCard.sameAsCardKey &&
      hasRequiredInstruction(activeCard);
    applyAllButton.classList.toggle('is-disabled', !canApplyToAll);
    applyAllButton.onclick = canApplyToAll ? null : event => event.preventDefault();
    applyAllButton.title = canApplyToAll
      ? 'この指示をほかのすべての制作画像に適用'
      : 'この画像の必須項目を入力すると使用できます';
  }
}

function setColorChoice(prefix, colorName) {
  setColorRole(prefix, 'main', colorName);
}

function getColorRoleValue(card, roleKey) {
  if (roleKey === 'sub') return card.baseColor || card.baseColorCode || '';
  if (roleKey === 'accent') return card.accentColor || card.accentColorCode || '';
  return card.mainColor || card.colorChoice || card.mainColorCode || '';
}

function getColorRoleOther(card, roleKey) {
  return card.colorOtherByRole?.[roleKey] || (roleKey === 'main' ? card.colorOther || '' : '');
}

function setColorRole(prefix, roleKey, colorName) {
  const card = getCard(prefix);
  if (!card) return;
  const valueKey = roleKey === 'sub' ? 'baseColor' : roleKey === 'accent' ? 'accentColor' : 'mainColor';
  const codeKey = roleKey === 'sub' ? 'baseColorCode' : roleKey === 'accent' ? 'accentColorCode' : 'mainColorCode';
  card[valueKey] = colorName;
  card[codeKey] = COLOR_PRESET_CODES[colorName] || '';
  card.colorChoice = roleKey === 'main' ? colorName : card.colorChoice;
  card.colorOtherByRole = card.colorOtherByRole || {};
  if (colorName !== 'その他') card.colorOtherByRole[roleKey] = '';
  if (roleKey === 'main') card.colorOther = colorName === 'その他' ? (card.colorOther || '') : '';
  rerenderDesignInstructions();
  saveDraft();
}

function updateColorRoleOther(prefix, roleKey, value) {
  const card = getCard(prefix);
  if (!card) return;
  card.colorOtherByRole = card.colorOtherByRole || {};
  card.colorOtherByRole[roleKey] = value;
  if (roleKey === 'main') card.colorOther = value;
  saveDraft();
}

function getInstructionCardLabel(card, targets = getInstructionTargets()) {
  const target = targets.find(item => item.id === card?.targetIds?.[0]);
  if (!target) return '制作画像';
  return `${target.displayName}／${target.sizeLabel}${target.quantity > 1 ? `／${card.imageNumber || 1}枚目` : ''}`;
}

function syncInstructionGroups() {
  const targets = getInstructionTargets();
  const previousCards = Array.isArray(state.imgCards) ? state.imgCards : [];
  const activeCard = previousCards[state.activeInstructionGroup];
  const activeTargetId = activeCard?.targetIds?.[0];
  const activeImageNumber = Number(activeCard?.imageNumber) || 1;
  const fallbackCard = previousCards.find(cardHasInstruction) || state.common || makeBlankCard();
  const rebuiltCards = [];

  targets.forEach(target => {
    const exactCards = previousCards
      .filter(card => card.targetIds?.length === 1 && card.targetIds[0] === target.id)
      .sort((a, b) => (Number(a.imageNumber) || 1) - (Number(b.imageNumber) || 1));
    const sharedLegacyCard = previousCards.find(card => card.targetIds?.includes(target.id));
    const sourceCards = exactCards.length
      ? exactCards
      : (sharedLegacyCard ? [sharedLegacyCard] : []);
    const cardCount = target.quantity;

    for (let imageIndex = 0; imageIndex < cardCount; imageIndex += 1) {
      const sourceCard = sourceCards[imageIndex] ||
        (!previousCards.length && imageIndex === 0 ? fallbackCard : makeBlankCard());
      rebuiltCards.push({
        ...cloneInstructionCard(sourceCard),
        targetIds: [target.id],
        imageNumber: imageIndex + 1
      });
    }
  });

  state.imgCards = rebuiltCards;
  const validCardKeys = new Set(state.imgCards.map(getInstructionCardKey));
  state.imgCards.forEach(card => {
    if (card.sameAsCardKey &&
        (!validCardKeys.has(card.sameAsCardKey) || card.sameAsCardKey === getInstructionCardKey(card))) {
      card.sameAsCardKey = '';
    }
  });
  state.imgMode = 'images';
  const restoredActiveIndex = state.imgCards.findIndex(card =>
    card.targetIds?.[0] === activeTargetId &&
    (Number(card.imageNumber) || 1) === activeImageNumber
  );
  state.activeInstructionGroup = restoredActiveIndex >= 0
    ? restoredActiveIndex
    : Math.min(Math.max(Number(state.activeInstructionGroup) || 0, 0), Math.max(state.imgCards.length - 1, 0));
  renderInstructionGroups();
}

function renderInstructionGroups() {
  const tabs = document.getElementById('instruction-group-tabs');
  let targetTabs = document.getElementById('instruction-target-tabs');
  if (!targetTabs && tabs?.parentElement) {
    targetTabs = document.createElement('div');
    targetTabs.id = 'instruction-target-tabs';
    targetTabs.className = 'instruction-target-tabs-fallback';
    tabs.parentElement.insertBefore(targetTabs, tabs);
  }
  const targets = getInstructionTargets();
  if (!state.imgCards.length) {
    state.imgCards = [makeBlankCard()];
    state.activeInstructionGroup = 0;
  }
  const activeIndex = state.activeInstructionGroup;
  const activeCard = state.imgCards[activeIndex] || state.imgCards[0] || makeBlankCard();
  if (activeCard.sameAsCardKey && !resolveInstructionCard(activeCard)) {
    activeCard.sameAsCardKey = '';
  }
  const activeTargetId = activeCard.targetIds?.[0] || targets[0]?.id || '';
  const activeTarget = targets.find(target => target.id === activeTargetId) || targets[0];
  const targetIndex = Math.max(targets.findIndex(target => target.id === activeTarget?.id), 0);
  const cardsForTarget = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => item.card.targetIds?.[0] === activeTarget?.id)
    .sort((a, b) => (Number(a.card.imageNumber) || 1) - (Number(b.card.imageNumber) || 1));
  const reusableCards = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => {
      if (item.index === activeIndex) return false;
      const resolvedCard = resolveInstructionCard(item.card);
      return resolvedCard && resolvedCard !== activeCard;
    });
  const reuseSource = activeCard.sameAsCardKey
    ? findInstructionCardByKey(activeCard.sameAsCardKey)
    : null;
  const reuseSourceHasInstruction = reuseSource ? hasRequiredInstruction(reuseSource) : false;

  tabs.classList.add('instruction-image-navigation');
  targetTabs.innerHTML = `
    <div class="instruction-image-targets">
      ${targets.map((target, index) => {
        const targetLabel = splitSizeSuggestion(target.sizeLabel);
        return `
          <button type="button" class="instruction-image-target instruction-color-${index % 6} ${target.id === activeTarget?.id ? 'is-active' : ''} ${isInstructionTargetComplete(target) ? 'is-complete' : ''}" data-target-id="${target.id}" onclick="selectInstructionTarget('${target.id}')">
            <span>${escHtml(target.displayName)}</span>
            <span class="instruction-image-meta">
              ${targetLabel.title ? `<strong>${escHtml(targetLabel.title)}</strong>` : ''}
              ${targetLabel.plan ? `<em>${escHtml(targetLabel.plan)}</em>` : ''}
            </span>
            <b class="instruction-image-dimension">${escHtml(targetLabel.dimension)}</b>
            <small>${target.quantity}枚</small>
            <i class="instruction-complete-icon ${isInstructionTargetComplete(target) ? 'is-visible' : ''}" aria-label="入力済み">✓</i>
          </button>`;
      }).join('')}
    </div>`;
  tabs.innerHTML = activeTarget?.quantity > 1 ? `
      <div class="instruction-copy-nav">
        <span class="instruction-copy-label">画像別の指示</span>
        <div class="instruction-copy-tabs">
          ${cardsForTarget.map(({ card, index }) => `
            <div class="instruction-group-tab-shell instruction-color-${targetIndex % 6} ${index === activeIndex ? 'is-active' : ''}">
              <button type="button" class="instruction-group-tab" onclick="selectInstructionGroup(${index})">
                <span>${card.imageNumber}枚目</span>
              </button>
            </div>`).join('')}
        </div>
        <span class="instruction-copy-status is-complete">${cardsForTarget.length}/${activeTarget.quantity}枚分</span>
      </div>` : '';

  const wrap = document.querySelector('#common-instructions-wrap .design-instruction-block');
  document.getElementById('common-instructions-wrap').classList.toggle('is-tabbed', activeTarget?.quantity > 1);
  wrap.innerHTML = `
    <div class="instruction-group-current instruction-color-${targetIndex % 6}">
      <div>
        <span>編集中</span>
        <strong>${activeTarget ? `${escHtml(activeTarget.displayName)}／${escHtml(activeTarget.sizeLabel)}` : '制作画像'}</strong>
      </div>
      <p>${activeTarget?.quantity > 1 ? `${activeCard.imageNumber || 1}枚目の指示` : 'この制作画像の指示'}</p>
    </div>
    ${instructionNotice ? `<div class="instruction-inline-notice" role="status">${escHtml(instructionNotice)}</div>` : ''}
    ${reusableCards.length ? `
      <div class="instruction-reuse-entry ${activeCard.sameAsCardKey ? 'is-active' : ''}">
        <label class="instruction-reuse-check">
          <input type="checkbox" ${activeCard.sameAsCardKey ? 'checked' : ''} onchange="setInstructionReuse(this.checked)">
          <span>他の制作画像と同じ指示にする</span>
        </label>
        <small>${activeCard.sameAsCardKey ? '参照する画像を選んでください' : '同じ内容なら入力を省略できます'}</small>
      </div>` : ''}
    ${activeCard.sameAsCardKey ? `
      <div class="instruction-reuse-control is-active ${reuseSourceHasInstruction ? '' : 'is-invalid'}">
          <div class="instruction-reuse-source">
            <label for="instruction-reuse-select">同じ指示を使う画像</label>
            <select id="instruction-reuse-select" onchange="setInstructionReuseSource(this.value)">
              ${reusableCards.map(({ card }) => `
                <option value="${escAttr(getInstructionCardKey(card))}" ${getInstructionCardKey(card) === activeCard.sameAsCardKey ? 'selected' : ''}>${escHtml(getInstructionCardLabel(card, targets))}${hasRequiredInstruction(card) ? '' : '（指示未入力）'}</option>
              `).join('')}
            </select>
            ${reuseSourceHasInstruction ? '' : '<div class="instruction-reuse-error" role="alert">選択した画像の指示が未入力または未完了です。先に参照元の指示を入力してください。</div>'}
            <p class="instruction-reuse-release-note">「他の制作画像と同じ指示にする」を解除すると、参照元の内容は引き継がれず、この画像の個別入力へ切り替わります。</p>
          </div>
      </div>` : ''}
    ${activeCard.sameAsCardKey ? `
      <div class="instruction-reuse-summary ${reuseSourceHasInstruction ? '' : 'is-invalid'}">
        <span>${reuseSourceHasInstruction ? '同じ指示を設定済み' : '参照元の入力待ち'}</span>
        <strong>${escHtml(getInstructionCardLabel(reuseSource, targets))}</strong>
        <p>${reuseSourceHasInstruction ? '選択した制作画像の指示内容が、そのまま適用されます。' : '参照元の指示を入力すると、この制作画像にも同じ内容が適用されます。'}</p>
      </div>
    ` : renderCardTemplate('card-' + activeIndex, activeCard)}
  `;
  if (!activeCard.sameAsCardKey) {
    initMoodTagsInto('moodtags-card-' + activeIndex, activeCard, 'card-' + activeIndex);
    renderCardFileLists('card-' + activeIndex, activeCard);
  }
  renderFloatingMediaSummary(4);
}

function selectInstructionGroup(groupIndex) {
  instructionNotice = '';
  state.activeInstructionGroup = groupIndex;
  renderInstructionGroups();
}

function cardHasAnyInput(card) {
  if (!card) return false;
  normalizeCardDetails(card);
  return !!(
    cardHasInstruction(card) ||
    card.staffPhotoAllowed ||
    String(card.personFreeNote || '').trim() ||
    String(card.refNote || '').trim() ||
    String(card.fileShareUrl || '').trim() ||
    (card.personFiles || []).length ||
    (card.refFiles || []).length ||
    (card.assetFiles || []).length
  );
}

function applyInstructionToUnenteredImages() {
  const sourceCard = state.imgCards[state.activeInstructionGroup];
  if (!sourceCard || sourceCard.sameAsCardKey || !hasRequiredInstruction(sourceCard)) {
    window.alert('この画像の必須項目を入力してから適用してください。');
    return;
  }
  const unenteredCards = state.imgCards.filter(card => card !== sourceCard && !cardHasAnyInput(card));
  if (!unenteredCards.length) {
    window.alert('未入力の制作画像はありません。');
    return;
  }
  const sourceKey = getInstructionCardKey(sourceCard);
  const sourceLabel = getInstructionCardLabel(sourceCard);
  if (!window.confirm(`「${sourceLabel}」の指示を、未入力の制作画像${unenteredCards.length}枚に適用しますか？\n入力途中・設定済みの画像は変更されません。`)) return;

  unenteredCards.forEach(card => {
    card.sameAsCardKey = sourceKey;
  });
  saveDraft();
  renderInstructionGroups();
}

function applyInstructionToCurrentTarget() {
  const sourceCard = state.imgCards[state.activeInstructionGroup];
  if (!sourceCard || sourceCard.sameAsCardKey || !hasRequiredInstruction(sourceCard)) {
    window.alert('この画像の必須項目を入力してから適用してください。');
    return;
  }
  const targetId = sourceCard.targetIds?.[0];
  const targetCards = state.imgCards.filter(card => card !== sourceCard && card.targetIds?.[0] === targetId);
  if (!targetCards.length) return;

  const sourceKey = getInstructionCardKey(sourceCard);
  const sourceLabel = getInstructionCardLabel(sourceCard);
  const enteredCount = targetCards.filter(cardHasAnyInput).length;
  const overwriteNote = enteredCount ? `\nうち${enteredCount}枚の入力済み指示は上書きされます。` : '';
  if (!window.confirm(`「${sourceLabel}」の指示を、同じサイズの残り${targetCards.length}枚に適用しますか？${overwriteNote}`)) return;

  targetCards.forEach(card => {
    card.sameAsCardKey = sourceKey;
  });
  saveDraft();
  renderInstructionGroups();
}

function resetCurrentInstructionCard() {
  const activeIndex = state.activeInstructionGroup;
  const currentCard = state.imgCards[activeIndex];
  if (!currentCard) return;

  const currentKey = getInstructionCardKey(currentCard);
  const referencesCurrentCard = (card, visitedKeys = new Set()) => {
    if (!card?.sameAsCardKey || visitedKeys.has(card.sameAsCardKey)) return false;
    if (card.sameAsCardKey === currentKey) return true;
    visitedKeys.add(card.sameAsCardKey);
    return referencesCurrentCard(findInstructionCardByKey(card.sameAsCardKey), visitedKeys);
  };
  const dependentCards = state.imgCards.filter((card, index) =>
    index !== activeIndex && referencesCurrentCard(card)
  );
  const dependentNote = dependentCards.length
    ? `\nこの画像を参照している${dependentCards.length}件の画像は、個別入力に戻ります。`
    : '';
  if (!window.confirm(`この画像の人物設定・制作指示・添付素材・詳細設定をすべてリセットしますか？${dependentNote}`)) return;

  ['personFiles', 'refFiles', 'assetFiles'].forEach(key => {
    (currentCard[key] || []).forEach(file => {
      const previewUrl = filePreviewUrls.get(file);
      if (previewUrl) {
        URL.revokeObjectURL(previewUrl);
        filePreviewUrls.delete(file);
      }
    });
  });
  dependentCards.forEach(card => {
    card.sameAsCardKey = '';
  });
  state.imgCards[activeIndex] = {
    ...makeBlankCard(),
    targetIds: [...(currentCard.targetIds || [])],
    imageNumber: Number(currentCard.imageNumber) || 1
  };
  saveDraft();
  renderInstructionGroups();
}

function resetAllInstructionCards() {
  if (!state.imgCards.length) return;
  if (!window.confirm('すべての画像の人物設定・制作指示・添付素材・詳細設定をリセットしますか？')) return;

  state.imgCards.forEach(card => {
    ['personFiles', 'refFiles', 'assetFiles'].forEach(key => {
      (card[key] || []).forEach(file => {
        const previewUrl = filePreviewUrls.get(file);
        if (previewUrl) {
          URL.revokeObjectURL(previewUrl);
          filePreviewUrls.delete(file);
        }
      });
    });
  });
  state.imgCards = state.imgCards.map(card => ({
    ...makeBlankCard(),
    targetIds: [...(card.targetIds || [])],
    imageNumber: Number(card.imageNumber) || 1
  }));
  state.activeInstructionGroup = 0;
  instructionNotice = 'すべての画像の指示をリセットしました。';
  saveDraft();
  renderInstructionGroups();
}

function selectInstructionTarget(targetId) {
  instructionNotice = '';
  const cardIndex = state.imgCards.findIndex(card => card.targetIds?.[0] === targetId);
  if (cardIndex >= 0) state.activeInstructionGroup = cardIndex;
  closeMobileMediaMenu();
  renderInstructionGroups();
}

function setInstructionReuse(enabled) {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  if (!activeCard) return;
  if (!enabled) {
    activeCard.sameAsCardKey = '';
    instructionNotice = '同じ指示の設定を解除しました。新しい制作指示を入力してください。';
  } else {
    instructionNotice = '';
    const sourceCards = state.imgCards.filter((card, index) =>
      index !== state.activeInstructionGroup &&
      resolveInstructionCard(card) &&
      resolveInstructionCard(card) !== activeCard
    );
    const sourceCard = sourceCards.find(hasRequiredInstruction) || sourceCards[0];
    activeCard.sameAsCardKey = sourceCard ? getInstructionCardKey(sourceCard) : '';
  }
  renderInstructionGroups();
}

function setInstructionReuseSource(cardKey) {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  const sourceCard = findInstructionCardByKey(cardKey);
  if (!activeCard || !sourceCard || sourceCard === activeCard) return;
  activeCard.sameAsCardKey = cardKey;
  renderInstructionGroups();
}

function addInstructionImage() {
  const activeCard = state.imgCards[state.activeInstructionGroup];
  const targetId = activeCard?.targetIds?.[0];
  const target = getInstructionTargets().find(item => item.id === targetId);
  if (!target) return;
  const targetCards = state.imgCards
    .map((card, index) => ({ card, index }))
    .filter(item => item.card.targetIds?.[0] === targetId);
  if (targetCards.length >= target.quantity) return;
  const insertIndex = targetCards[targetCards.length - 1].index + 1;
  state.imgCards.splice(insertIndex, 0, {
    ...makeBlankCard(),
    targetIds: [targetId],
    imageNumber: targetCards.length + 1
  });
  state.activeInstructionGroup = insertIndex;
  renderInstructionGroups();
}

function confirmRemoveInstructionImage(event, cardIndex) {
  event.stopPropagation();
  const card = state.imgCards[cardIndex];
  if (!card || (Number(card.imageNumber) || 1) <= 1) return;
  const confirmed = window.confirm(`${card.imageNumber}枚目の指示を削除しますか？`);
  if (confirmed) removeInstructionImage(cardIndex);
}

function removeInstructionImage(cardIndex) {
  const targetId = state.imgCards[cardIndex]?.targetIds?.[0];
  state.imgCards.splice(cardIndex, 1);
  const targetCards = state.imgCards.filter(card => card.targetIds?.[0] === targetId);
  targetCards.forEach((card, index) => { card.imageNumber = index + 1; });
  const nextIndex = state.imgCards.findIndex(card => card.targetIds?.[0] === targetId);
  state.activeInstructionGroup = nextIndex >= 0
    ? Math.min(nextIndex, state.imgCards.length - 1)
    : Math.min(cardIndex, state.imgCards.length - 1);
  renderInstructionGroups();
}

/* ========== STEP 5: 納期・指名 ========== */
function setDelivery(value) {
  state.delivery = value;
  ['d1', 'd2', 'd3'].forEach(id => document.getElementById('rb-' + id).classList.remove('sel'));
  const targetButtonId = DELIVERY_BUTTON_ID_BY_VALUE[value];
  if (targetButtonId) document.getElementById('rb-' + targetButtonId).classList.add('sel');
  document.getElementById('date-input').style.display = value === '納期指定' ? 'block' : 'none';
  const deliveryPicker = document.getElementById('delivery-calendar-picker'); if (deliveryPicker) deliveryPicker.hidden = true;
  document.getElementById('f-delivery').classList.remove('inv');
  if (value === '納期指定') {
    handleDeliveryDateChange(document.getElementById('inp-date'));
    renderDeliveryCalendar();
  }
}
setDelivery = function(value) {
  state.delivery = value;
  ['d1', 'd2', 'd3'].forEach(id => document.getElementById('rb-' + id)?.classList.remove('sel'));
  const buttonId = value === '\u5e0c\u671b\u306a\u3057' ? 'd1' : value === '\u4e8b\u524d\u4e88\u7d04' ? 'd2' : value === '\u7d0d\u671f\u6307\u5b9a' ? 'd3' : '';
  if (buttonId) document.getElementById('rb-' + buttonId)?.classList.add('sel');
  const dateInput = document.getElementById('date-input');
  if (dateInput) dateInput.style.display = value === '\u7d0d\u671f\u6307\u5b9a' ? 'block' : 'none';
  const showRateTable = value === '\u7d0d\u671f\u6307\u5b9a';
  document.querySelectorAll('.deadline-rate-note, .deadline-rate-details').forEach(el => { el.hidden = !showRateTable; });
  const picker = document.getElementById('delivery-calendar-picker');
  if (picker) picker.hidden = true;
  document.getElementById('f-delivery')?.classList.remove('inv');
  if (value === '\u7d0d\u671f\u6307\u5b9a') { handleDeliveryDateChange(document.getElementById('inp-date')); renderDeliveryCalendar(); }
};
function toggleDeliveryCalendar() { const picker = document.getElementById('delivery-calendar-picker'); if (!picker) return; picker.hidden = !picker.hidden; if (!picker.hidden) renderDeliveryCalendar(); }

let deliveryCalendarView = new Date();
function formatDeliveryInputDate(date) { return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`; }
function renderDeliveryCalendar() {
  const picker = document.getElementById('delivery-calendar-picker'); if (!picker) return;
  const year = deliveryCalendarView.getFullYear(), month = deliveryCalendarView.getMonth(), firstDay = new Date(year, month, 1).getDay(), daysInMonth = new Date(year, month + 1, 0).getDate(), selected = document.getElementById('inp-date')?.value || '', todayValue = formatDeliveryInputDate(new Date()), weekdays = ['日','月','火','水','木','金','土'];
  let cells = ''; for (let i = 0; i < firstDay; i += 1) cells += '<span class="delivery-calendar-day is-empty" aria-hidden="true"></span>';
  for (let day = 1; day <= daysInMonth; day += 1) { const value = formatDeliveryInputDate(new Date(year, month, day)), disabled = isNonWorkingDeliveryDate(value), classes = ['delivery-calendar-day', disabled ? 'is-non-working' : '', value === selected ? 'is-selected' : '', value === todayValue ? 'is-today' : ''].filter(Boolean).join(' '); cells += `<button type="button" class="${classes}" ${disabled ? 'disabled' : ''} onclick="selectDeliveryDate('${value}')">${day}</button>`; }
  picker.innerHTML = `<div class="delivery-calendar-head"><button type="button" class="delivery-calendar-nav" onclick="shiftDeliveryCalendar(-1)" aria-label="前の月">‹</button><strong>${year}年${month + 1}月</strong><button type="button" class="delivery-calendar-nav" onclick="shiftDeliveryCalendar(1)" aria-label="次の月">›</button></div><div class="delivery-calendar-weekdays">${weekdays.map(day => `<span>${day}</span>`).join('')}</div><div class="delivery-calendar-grid">${cells}</div><p class="delivery-calendar-help">稼働日外は選択できません。</p>`;
}
renderDeliveryCalendar = function() {
  const picker = document.getElementById('delivery-calendar-picker');
  if (!picker) return;
  const year = deliveryCalendarView.getFullYear();
  const month = deliveryCalendarView.getMonth();
  const firstDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const selected = document.getElementById('inp-date')?.value || '';
  const todayValue = formatDeliveryInputDate(new Date());
  const weekdays = ['\u65e5','\u6708','\u706b','\u6c34','\u6728','\u91d1','\u571f'];
  let cells = '';
  for (let i = 0; i < firstDay; i += 1) cells += '<span class="delivery-calendar-day is-empty" aria-hidden="true"></span>';
  for (let day = 1; day <= daysInMonth; day += 1) {
    const value = formatDeliveryInputDate(new Date(year, month, day));
    const disabled = isNonWorkingDeliveryDate(value);
    const classes = ['delivery-calendar-day', disabled ? 'is-non-working' : '', value === selected ? 'is-selected' : '', value === todayValue ? 'is-today' : ''].filter(Boolean).join(' ');
    cells += `<button type="button" class="${classes}" ${disabled ? 'disabled' : ''} onclick="selectDeliveryDate('${value}')" aria-label="${value}" title="${disabled ? '\u7a3c\u50cd\u65e5\u5916' : '\u9078\u629e\u53ef\u80fd'}">${day}</button>`;
  }
  picker.innerHTML = `<div class="delivery-calendar-head"><button type="button" class="delivery-calendar-nav" onclick="shiftDeliveryCalendar(-1)" aria-label="\u524d\u306e\u6708">‹</button><strong>${year}\u5e74${month + 1}\u6708</strong><button type="button" class="delivery-calendar-nav" onclick="shiftDeliveryCalendar(1)" aria-label="\u6b21\u306e\u6708">›</button></div><div class="delivery-calendar-weekdays">${weekdays.map(day => `<span>${day}</span>`).join('')}</div><div class="delivery-calendar-grid">${cells}</div><div class="delivery-calendar-legend"><span><i class="is-available"></i>選択可能</span><span><i class="is-off"></i>稼働日外</span></div>`;
};
function shiftDeliveryCalendar(delta) { deliveryCalendarView = new Date(deliveryCalendarView.getFullYear(), deliveryCalendarView.getMonth() + delta, 1); renderDeliveryCalendar(); }
function selectDeliveryDate(value) { if (isNonWorkingDeliveryDate(value)) return; const input = document.getElementById('inp-date'); if (!input) return; input.value = value; handleDeliveryDateChange(input); const picker = document.getElementById('delivery-calendar-picker'); if (picker) picker.hidden = true; renderDeliveryCalendar(); }

function handleDeliveryDateChange(input) {
  const value = input?.value || '';
  state.deliveryDate = value;
  const field = document.getElementById('f-delivery');
  const error = field?.querySelector('.err');
  if (!field || !error) return;
  if (!value) {
    field.classList.remove('inv');
    error.textContent = '納期希望を選択してください';
    return;
  }
  if (isNonWorkingDeliveryDate(value)) {
    field.classList.add('inv');
    error.textContent = '稼働日外です。別の営業日を選択してください';
    return;
  }
  field.classList.remove('inv');
  error.textContent = '納期希望を選択してください';
}

function syncDes(changed) {
  const ids = ['sel-des1', 'sel-des2', 'sel-des3'];
  const vals = ids.map(id => document.getElementById(id).value);
  ids.forEach((id, i) => {
    const sel = document.getElementById(id);
    const curVal = sel.value;
    const others = vals.filter((_, j) => j !== i && _);
    sel.querySelectorAll('option').forEach(option => { if (option.value) option.disabled = others.includes(option.value); });
    sel.value = curVal;
  });
  state.des1 = document.getElementById('sel-des1').value;
  state.des2 = document.getElementById('sel-des2').value;
  state.des3 = document.getElementById('sel-des3').value;
}

/* ========== UTIL ========== */
function escAttr(s) { return (s || '').replace(/"/g, '&quot;'); }
function escHtml(s) { return (s || '').replace(/</g, '&lt;'); }

/* ========== PREVIEW ========== */
function cardSummary(card, isIndividual) {
  normalizeCardDetails(card);
  const atmosphereTxt = card.moods.filter(mood => ATMOSPHERE_OPTIONS.includes(mood)).join('・') || '—';
  const worldviewTxt = card.moods.filter(mood => WORLDVIEW_OPTIONS.includes(mood)).join('・') || '—';
  const colorTxt = COLOR_ROLE_CONFIG.map(role => {
    const value = getColorRoleValue(card, role.key);
    const codeKey = role.key === 'sub' ? 'baseColorCode' : role.key === 'accent' ? 'accentColorCode' : 'mainColorCode';
    const roleCode = normalizeColorCode(card[codeKey]);
    if (!value && !roleCode) return `${role.label}：—`;
    if (value === 'その他') return `${role.label}：その他（${getColorRoleOther(card, role.key) || '未入力'}）`;
    const presetName = COLOR_PRESET_CODES[value] ? value : '';
    return `${role.label}：${presetName ? `${presetName} ` : ''}${roleCode || value}`;
  }).join(' / ');
  const personUsage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
  let assetExtra = '';
  const personFiles = (card.personFiles || []).map(file => file.name).join(', ');
  const refFiles = (card.refFiles || []).map(file => file.name).join(', ');
  if (card.assetNote || card.assetFiles.length || personFiles || refFiles || card.fileShareUrl) {
    assetExtra = `<div class="prow"><span class="pk">素材・参考情報</span><span class="pv">${card.assetNote || '—'}</span></div>
      <div class="prow"><span class="pk">人物素材</span><span class="pv">${personFiles || 'なし'}</span></div>
      <div class="prow"><span class="pk">参考画像</span><span class="pv">${refFiles || 'なし'}</span></div>
      <div class="prow"><span class="pk">ファイル共有URL</span><span class="pv">${card.fileShareUrl || 'なし'}</span></div>
      <div class="prow"><span class="pk">添付ファイル</span><span class="pv">${card.assetFiles.length ? card.assetFiles.map(file => file.name).join(', ') : 'なし'}</span></div>`;
  }
  let personExtra = '';
  if (personUsage === '使用する') {
    personExtra = `<div class="prow"><span class="pk">在籍写真の使用</span><span class="pv">${card.staffPhotoAllowed ? '可' : '不可'}</span></div>`;
  }
  return `
    ${isIndividual ? `<div class="prow"><span class="pk">対象画像</span><span class="pv">${card.targetImage || '—'}</span></div>` : ''}
    <div class="prow"><span class="pk">人物写真</span><span class="pv">${personUsage || '—'}</span></div>
    ${personExtra}
    ${assetExtra}
    <div class="prow"><span class="pk">掲載文言</span><span class="pv">${card.copyTxt || '—'}</span></div>
    <div class="prow"><span class="pk">デザイン指示</span><span class="pv">${card.design === 'おまかせ' ? 'おまかせ' : (card.designTxt || '—')}</span></div>
    <div class="prow"><span class="pk">カラー</span><span class="pv">${colorTxt}</span></div>
    <div class="prow"><span class="pk">カラー補足</span><span class="pv">${card.colorNote || '—'}</span></div>
    <div class="prow"><span class="pk">雰囲気</span><span class="pv">${atmosphereTxt}</span></div>
    <div class="prow"><span class="pk">雰囲気・その他</span><span class="pv">${card.atmosphereOther || '—'}</span></div>
    <div class="prow"><span class="pk">デザイン要素・モチーフ</span><span class="pv">${worldviewTxt}</span></div>
    <div class="prow"><span class="pk">デザイン要素・その他</span><span class="pv">${card.worldviewOther || '—'}</span></div>`;
}

function buildPreview() {
  const fieldValue = id => { const e = document.getElementById(id); return e ? e.value || '—' : '—'; };

  const mediaDetailHtml = state.selectedMedia.map(mediumName => {
    const sizes = getSelectedSizeEntriesForMedium(mediumName);
    return `<div class="prow"><span class="pk">${escHtml(getMediumDisplayName(mediumName))}</span><span class="pv">${sizes.map(entry => escHtml(formatSizeWithQuantity(entry))).join(' / ') || '—'}</span></div>`;
  }).join('');

  const instructionTargets = getInstructionTargets();
  const individualDesignHtml = state.imgCards
    .filter(card => (card.targetIds || []).length)
    .map(card => {
      const target = instructionTargets.find(item => item.id === card.targetIds?.[0]);
      const targetLabel = target
        ? `${target.displayName}／${target.sizeLabel}${target.quantity > 1 ? `／${card.imageNumber || 1}枚目` : ''}`
        : '';
      const reuseSource = card.sameAsCardKey ? resolveInstructionCard(card) : null;
      return `
        <div class="psec-h" style="margin-top:10px">${escHtml(targetLabel) || '制作画像'}</div>
        ${reuseSource
          ? `<div class="prow"><span class="pk">デザイン指示</span><span class="pv">${escHtml(getInstructionCardLabel(reuseSource, instructionTargets))}と同じ</span></div>`
          : cardSummary(card, false)}`;
    }).join('') || cardSummary(state.common, false);
  const designHtml = individualDesignHtml;

  return `
    <div class="psec">
      <div class="psec-h">依頼者情報</div>
      <div class="prow"><span class="pk">支社名</span><span class="pv">${state.office || '—'}</span></div>
      <div class="prow"><span class="pk">営業担当者</span><span class="pv">${fieldValue('sel-staff') || fieldValue('inp-staff-other') || '—'}</span></div>
      <div class="prow"><span class="pk">フォーム記入者</span><span class="pv">${state.client}</span></div>
      <div class="prow"><span class="pk">メールアドレス</span><span class="pv">${fieldValue('inp-email')}</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">画像種別・依頼内容</div>
      <div class="prow"><span class="pk">画像について</span><span class="pv">${['', '新規作成', '修正', '有料案件'][state.imgType] || '—'}</span></div>
      <div class="prow"><span class="pk">請求方法</span><span class="pv">${state.pay}${state.pay === '有料' ? ' (入稿URL: ' + fieldValue('inp-pay-url') + ')' : ''}</span></div>
      <div class="prow"><span class="pk">店舗名</span><span class="pv">${fieldValue('inp-shop')}</span></div>
      <div class="prow"><span class="pk">エリア</span><span class="pv">${fieldValue('inp-area')}</span></div>
      <div class="prow"><span class="pk">掲載URL</span><span class="pv">${state.urlMode === 'なし' ? 'URLなし' : fieldValue('inp-shopurl')}</span></div>
      <div class="prow"><span class="pk">ホームページURL</span><span class="pv">${state.urlMode2 === 'なし' ? 'URLなし' : fieldValue('inp-shopurl2') || '—'}</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">業種・媒体・サイズ</div>
      <div class="prow"><span class="pk">業種</span><span class="pv">${state.industry === 'その他' ? state.industryOther || 'その他' : state.industry || '—'}</span></div>
      <div class="prow"><span class="pk">制作内容</span><span class="pv">${getProductionTypeSelections().join('・') || '—'}</span></div>
      ${mediaDetailHtml || '<div class="prow"><span class="pk">媒体</span><span class="pv">—</span></div>'}
      <div class="prow"><span class="pk">媒体・サイズ（自動まとめ）</span><span class="pv">${fieldValue('inp-imgsize')}</span></div>
      <div class="prow"><span class="pk">画像総枚数</span><span class="pv">${fieldValue('inp-count')}枚</span></div>
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">デザイン指示</div>
      ${designHtml}
    </div>
    <div class="pdiv"></div>
    <div class="psec">
      <div class="psec-h">納期・指名</div>
      <div class="prow"><span class="pk">納期希望</span><span class="pv">${state.delivery || '—'}${state.delivery === '納期指定' ? ' (' + fieldValue('inp-date') + ')' : ''}</span></div>
      <div class="prow"><span class="pk">デザイナー指名</span><span class="pv">${[state.des1, state.des2, state.des3].filter(Boolean).join(' / ') || '指名なし'}</span></div>
    </div>`;
}

/* ========== VALIDATION ========== */
function validateCard(prefix, card, validationRef, isIndividual) {
  const reqField = (fieldId, isValid) => {
    if (fieldId.startsWith('f-designtxt-')) return;
    const fieldEl = document.getElementById(fieldId);
    if (!fieldEl) return;
    if (!isValid()) { fieldEl.classList.add('inv'); validationRef.ok = false; }
    else fieldEl.classList.remove('inv');
  };
  // 個別モードでは対象画像の入力も必須
  if (isIndividual) {
    const targetEl = document.querySelector(`#imgcard-${prefix.replace('card-', '')} .field:first-of-type`);
    if (!card.targetImage.trim()) {
      if (targetEl) targetEl.classList.add('inv');
      validationRef.ok = false;
    } else {
      if (targetEl) targetEl.classList.remove('inv');
    }
  }
  reqField(`f-person-${prefix}`, () => {
    const usage = card.personUsage || (card.person === '使用しない' ? '使用しない' : (card.person ? '使用する' : ''));
    return usage === '使用する' || usage === '使用しない';
  });
  // デザイン指示が空欄の場合は次のステップでおまかせ確認モーダルを表示するため、ここでは阻止しない。
  reqField(`f-designtxt-${prefix}`, () => true);
}

function validate(step) {
  let ok = true;
  const req = (fieldId, isValid) => {
    const fieldEl = document.getElementById(fieldId);
    if (!fieldEl) return;
    if (!isValid()) { fieldEl.classList.add('inv'); ok = false; }
    else fieldEl.classList.remove('inv');
  };

  if (step === 1) {
    // 依頼者情報は必須表示を残しつつ、未入力でも次へ進める。
    ['f-office', 'f-staff', 'f-agent', 'f-email'].forEach(id => document.getElementById(id)?.classList.remove('inv'));
    return ok;
    req('f-office', () => document.getElementById('sel-office').value);
    const officeValue = document.getElementById('sel-office').value;
    if (officeValue === 'VOTEC' || officeValue === 'その他')
      req('f-staff', () => document.getElementById('inp-staff-other').value.trim());
    else
      req('f-staff', () => document.getElementById('sel-staff').value);
    if (state.client === '代理')
      req('f-agent', () => document.getElementById('inp-agent').value.trim());
    req('f-email', () => {
      const emailValue = document.getElementById('inp-email').value;
      return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailValue) ? emailValue : '';
    });
  }
  if (step === 2) {
    req('f-imgtype', () => state.imgType ? 'ok' : '');
    if (state.pay === '有料')
      req('f-pay-url', () => document.getElementById('inp-pay-url').value.trim());
    req('f-shop',    () => document.getElementById('inp-shop').value.trim());
    req('f-area',    () => document.getElementById('inp-area').value.trim());
    req('f-industry', () => state.industry);
    if (state.urlMode === 'あり')
      req('f-shopurl', () => document.getElementById('inp-shopurl').value.trim());
  }
  if (step === 3) {
    if (state.industry === 'その他')
      req('f-industry-other', () => document.getElementById('inp-industry-other').value.trim());
    req('f-medium',   () => state.selectedMedia.length ? 'ok' : '');
    if (state.selectedMedia.includes('その他'))
      req('f-medium-other', () => document.getElementById('inp-medium-other').value.trim());
    if (!validateSelectedMediaSizes()) ok = false;
  }
  if (step === 4) {
    const validationRef = { ok: true };
    const instructionTargets = getInstructionTargets();
    const missingTarget = instructionTargets.find(target =>
      state.imgCards.filter(card => card.targetIds?.[0] === target.id).length < target.quantity
    );
    if (missingTarget) {
      selectInstructionTarget(missingTarget.id);
      ok = false;
    }
    const imageCards = state.imgCards
      .map((card, index) => ({ card, index }))
      .filter(item => (item.card.targetIds || []).length);
    const invalidGroup = imageCards.find(({ card }) => !hasRequiredInstruction(card));
    if (invalidGroup) {
      state.activeInstructionGroup = invalidGroup.index;
      renderInstructionGroups();
      if (invalidGroup.card.sameAsCardKey) {
        validationRef.ok = false;
      } else {
        validateCard('card-' + invalidGroup.index, invalidGroup.card, validationRef, false);
      }
    }
    ok = ok && validationRef.ok;
  }
  if (step === 5) {
    req('f-delivery', () => state.delivery);
    if (state.delivery === '納期指定') {
      const deliveryDateInput = document.getElementById('inp-date');
      const deliveryDate = deliveryDateInput.value;
      const error = document.querySelector('#f-delivery .err');
      if (error) error.textContent = '納期希望を選択してください';
      if (!deliveryDate) {
        document.getElementById('f-delivery').classList.add('inv');
        ok = false;
      } else if (isNonWorkingDeliveryDate(deliveryDate)) {
        document.getElementById('f-delivery').classList.add('inv');
        if (error) error.textContent = '稼働日外は指定できません。社内稼働カレンダーを確認してください';
        ok = false;
      }
    }
  }
  return ok;
}

function scrollToFirstError() {
  const activePanel = document.querySelector('.panel.on');
  if (!activePanel) return;

  const errorField = activePanel.querySelector('.inv');
  if (!errorField) return;

  errorField.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const focusable = errorField.querySelector('input:not([type="hidden"]), select, textarea, button, .rbtn, .rcard');
  if (focusable && typeof focusable.focus === 'function') {
    setTimeout(() => focusable.focus({ preventScroll: true }), 250);
  }
}

/* ========== NAVIGATION ========== */
function goTo(step) {
  repairStaticJapaneseLabels();
  closeMobileMediaMenu();
  if (step <= totalSteps) maxVisitedStep = Math.max(maxVisitedStep, step);
  document.querySelectorAll('.panel').forEach(panel => panel.classList.remove('on'));
  const activePanel = document.getElementById(step <= totalSteps ? 'p' + step : 'p-success');
  activePanel.classList.add('on');

  const noticeStack = document.querySelector('.notice-stack');
  if (noticeStack) noticeStack.style.display = step === 1 ? 'grid' : 'none';

  for (let i = 1; i <= totalSteps; i++) {
    const dotEl = document.getElementById('d' + i);
    const labelEl = document.getElementById('l' + i);
    const itemEl = dotEl.closest('.sc-item');
    const canNavigate = i !== step && i <= maxVisitedStep;
    dotEl.className = 'sc-dot' + (i < step ? ' done' : i === step ? ' on' : '');
    dotEl.innerHTML = i < step ? '<i class="ti ti-check"></i>' : String(i);
    labelEl.className = 'sc-lbl' + (i === step ? ' on' : '');
    itemEl.classList.toggle('is-clickable', canNavigate);
    itemEl.onclick = canNavigate ? () => jumpToStep(i) : null;
    itemEl.onkeydown = canNavigate
      ? event => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault();
            jumpToStep(i);
          }
        }
      : null;
    if (canNavigate) {
      itemEl.setAttribute('role', 'button');
      itemEl.setAttribute('tabindex', '0');
      itemEl.setAttribute('aria-label', `${labelEl.textContent}へ移動`);
    } else {
      itemEl.removeAttribute('role');
      itemEl.removeAttribute('tabindex');
      itemEl.removeAttribute('aria-label');
    }
    if (i < totalSteps) {
      const lineEl = document.getElementById('ln' + i);
      if (lineEl) lineEl.className = 'sc-line' + (i < step ? ' done' : '');
    }
  }

  document.getElementById('prog').style.width = (step / totalSteps * 100) + '%';
  document.getElementById('btn-back').style.display = step > 1 ? 'inline-flex' : 'none';

  const nextBtn = document.getElementById('btn-next');
  nextBtn.innerHTML = step === totalSteps
    ? '送信する <i class="ti ti-send"></i>'
    : '次へ <i class="ti ti-arrow-right"></i>';

  const currentTitleEl = activePanel.querySelector('.ptitle');
  const stepTitle = step <= totalSteps && currentTitleEl ? currentTitleEl.textContent : '完了';
  document.getElementById('header-step-value').textContent = `${Math.min(step, totalSteps)} / ${totalSteps} ・ ${stepTitle}`;

  if (step > totalSteps) document.getElementById('nav-bar').style.display = 'none';
  renderFloatingMediaSummary(step);
  repairVisibleLabels();
  repairStaticJapaneseLabels();
  repairDynamicJapaneseLabels();
  repairVisibleLabels();

  requestAnimationFrame(() => activePanel.scrollIntoView({ behavior: 'auto', block: 'start' }));
}

function jumpToStep(step) {
  if (step < 1 || step > maxVisitedStep || step === currentStep) return;
  currentStep = step;
  if (currentStep === 4) syncInstructionGroups();
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

let blankDesignModalResolver = null;

function getBlankDesignInstructionCards() {
  const sourceCards = state.imgCards.length ? state.imgCards : (state.common ? [state.common] : []);
  const seen = new Set();
  return sourceCards.filter(card => {
    const effectiveCard = resolveInstructionCard(card) || card;
    if (!effectiveCard || seen.has(effectiveCard)) return false;
    seen.add(effectiveCard);
    return effectiveCard.design !== 'おまかせ' && !hasDesignInstructionContent(effectiveCard.designTxt);
  }).map(card => resolveInstructionCard(card) || card);
}

function resolveBlankDesignModal(accept) {
  const modal = document.getElementById('blank-design-confirm-modal');
  if (accept) {
    getBlankDesignInstructionCards().forEach(card => {
      card.design = 'おまかせ';
      card.designTxt = 'おまかせ';
    });
    saveDraft();
    rerenderDesignInstructions();
  }
  if (modal) modal.hidden = true;
  const resolver = blankDesignModalResolver;
  blankDesignModalResolver = null;
  resolver?.(accept);
  if (!accept) {
    currentStep = 4;
    goTo(4);
    requestAnimationFrame(() => {
      document.querySelector('.design-instruction-textarea')?.focus({ preventScroll: true });
      document.querySelector('.design-instruction-textarea')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }
}

function confirmBlankDesignInstructions() {
  if (!getBlankDesignInstructionCards().length) return Promise.resolve(true);
  const modal = document.getElementById('blank-design-confirm-modal');
  if (!modal) return Promise.resolve(true);
  modal.hidden = false;
  requestAnimationFrame(() => modal.querySelector('.blank-design-confirm-primary')?.focus());
  return new Promise(resolve => { blankDesignModalResolver = resolve; });
}

async function nextStep() {
  if (currentStep === 4) {
    const bulkPanel = document.querySelector('.bulk-instruction-panel');
    if (bulkPanel?.open && !applyBulkInstructions({ automatic: true })) {
      document.getElementById('bulk-instruction-input')?.focus();
      return;
    }
    if (!(await confirmBlankDesignInstructions())) return;
  }
  // サイズ未入力の媒体だけは、テスト用の未完了ナビゲーションでも先へ進ませない。
  if (currentStep === 3 && !validateSelectedMediaSizes()) {
    scrollToFirstError();
    return;
  }
  if (!TEST_MODE_ALLOW_INCOMPLETE_NAVIGATION && !validate(currentStep)) {
    scrollToFirstError();
    return;
  }
  if (currentStep === totalSteps) { submit(); return; }
  currentStep++;
  if (currentStep === 4) {
    syncInstructionGroups();
  }
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

function prevStep() {
  if (currentStep > 1) { currentStep--; goTo(currentStep); }
}

function submit() {
  deleteDraft({silent: true});
  goTo(totalSteps + 1);
  document.getElementById('req-id').textContent = 'BNR-' + Date.now().toString(36).toUpperCase();
}

function continueRequest() {
  window.location.href = 'form.html?new=' + Date.now();
}

/* ========== 一時保存（明示操作のみ） ========== */
function getPersistableState() {
  return JSON.parse(JSON.stringify(state, (key, value) => {
    if (key === 'files' || key === 'personFiles' || key === 'refFiles' ||
        key === 'assetFiles' || key === 'bulkAssetFiles') return [];
    return value;
  }));
}

function collectDraftControls() {
  const controls = {};
  document.querySelectorAll('input[id], select[id], textarea[id]').forEach(control => {
    if (control.type === 'file' || control.type === 'hidden') return;
    controls[control.id] = control.type === 'checkbox' || control.type === 'radio'
      ? { checked: control.checked }
      : { value: control.value };
  });
  return controls;
}

function formatDraftSavedAt(timestamp) {
  if (!timestamp) return '';
  const date = new Date(timestamp);
  return `一時保存済み：${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function updateDraftStatus(timestamp = null, message = '') {
  const status = document.getElementById('draft-status');
  const deleteButton = document.getElementById('btn-draft-delete');
  if (status) status.textContent = message || formatDraftSavedAt(timestamp);
  if (deleteButton) deleteButton.hidden = !timestamp;
}

function saveDraft({ explicit = false } = {}) {
  // 入力変更・画面遷移では保存しない。保存ボタンからの明示操作だけを受け付ける。
  if (!explicit) return false;
  const savedAt = Date.now();
  try {
    localStorage.setItem(DRAFT_STORAGE_KEY, JSON.stringify({
      state: getPersistableState(),
      controls: collectDraftControls(),
      currentStep: Math.min(Math.max(currentStep, 1), totalSteps),
      maxVisitedStep: Math.min(Math.max(maxVisitedStep, currentStep), totalSteps),
      savedAt
    }));
    updateDraftStatus(savedAt, `${formatDraftSavedAt(savedAt)}　添付ファイルは保存されません。`);
    return true;
  } catch (error) {
    console.warn('入力内容を保存できませんでした。', error);
    updateDraftStatus(null, '一時保存できませんでした。');
    return false;
  }
}

function deleteDraft({ silent = false } = {}) {
  if (!silent && !window.confirm('一時保存した依頼内容を削除しますか？')) return false;
  try { localStorage.removeItem(DRAFT_STORAGE_KEY); } catch (error) { console.warn('一時保存を削除できませんでした。', error); }
  updateDraftStatus(null, silent ? '' : '一時保存を削除しました。');
  return true;
}

function readDraft() {
  try {
    const rawDraft = localStorage.getItem(DRAFT_STORAGE_KEY);
    return rawDraft ? JSON.parse(rawDraft) : null;
  } catch (error) {
    console.warn('保存済みの入力内容を読み込めませんでした。', error);
    return null;
  }
}

function hydrateDraftState(savedState) {
  if (!savedState || typeof savedState !== 'object') return;
  state = { ...state, ...savedState };
  state.selectedMedia = Array.isArray(savedState.selectedMedia) ? savedState.selectedMedia : [];
  state.openMedia = Array.isArray(savedState.openMedia) ? savedState.openMedia : [];
  state.mediaState = savedState.mediaState && typeof savedState.mediaState === 'object'
    ? savedState.mediaState
    : {};
  state.bulkAssetFiles = [];
  state.common = normalizeCardDetails({
    ...makeBlankCard(),
    ...(savedState.common || {}),
    personFiles: [],
    refFiles: [],
    assetFiles: []
  });
  state.imgCards = Array.isArray(savedState.imgCards)
    ? savedState.imgCards.map(card => normalizeCardDetails({
        ...makeBlankCard(),
        ...card,
        personFiles: [],
        refFiles: [],
        assetFiles: []
      }))
    : [];
  state.files = [];
}

function applyDraftControls(controls) {
  if (!controls || typeof controls !== 'object') return;
  Object.entries(controls).forEach(([id, savedControl]) => {
    const control = document.getElementById(id);
    if (!control || control.type === 'file') return;
    if (control.type === 'checkbox' || control.type === 'radio') {
      control.checked = !!savedControl.checked;
    } else if ('value' in savedControl) {
      control.value = savedControl.value;
    }
  });
}

function restoreDraftUI(draft) {
  const controls = draft && draft.controls ? draft.controls : {};

  const officeSelect = document.getElementById('sel-office');
  officeSelect.value = controls['sel-office']?.value || state.office || '';
  if (officeSelect.value) onOffice();

  setClient(state.client || '本人');
  if (state.imgType) setImgType(state.imgType);
  setUrlMode(1, state.urlMode === 'なし');
  setUrlMode(2, state.urlMode2 === 'なし');

  document.querySelectorAll('#industry-btns .rbtn').forEach(button => {
    button.classList.toggle('sel', button.textContent.trim() === state.industry);
  });
  document.querySelectorAll('#production-type-btns .rbtn').forEach(button => {
    button.classList.toggle('sel', getProductionTypeSelections().includes(button.textContent.trim()));
  });
  document.querySelectorAll('.fuzoku-warn').forEach(warning => {
    warning.style.display = state.industry === '風俗' ? 'flex' : 'none';
  });
  document.getElementById('f-industry-other').style.display = state.industry === 'その他' ? 'block' : 'none';
  renderMediumChips(getProductionTypeSelections());
  renderMediumBlocks();
  document.getElementById('f-medium-other').style.display =
    state.selectedMedia.includes('その他') ? 'block' : 'none';

  renderCommonBlock();
  autoFillImgSize();
  syncInstructionGroups();
  if (state.delivery) setDelivery(state.delivery);

  applyDraftControls(controls);
  const bulkInstructionInput = document.getElementById('bulk-instruction-input');
  if (bulkInstructionInput) bulkInstructionInput.value = state.bulkInstruction || '';
  renderBulkAssetFiles();
  state.industryOther = document.getElementById('inp-industry-other').value;
  state.mediumOther = document.getElementById('inp-medium-other').value;
  state.deliveryDate = document.getElementById('inp-date').value;
  state.des1 = document.getElementById('sel-des1').value;
  state.des2 = document.getElementById('sel-des2').value;
  state.des3 = document.getElementById('sel-des3').value;
  syncDes();

  currentStep = Math.min(Math.max(Number(draft.currentStep) || 1, 1), totalSteps);
  maxVisitedStep = Math.min(Math.max(Number(draft.maxVisitedStep) || currentStep, currentStep), totalSteps);
  if (currentStep === totalSteps) {
    document.getElementById('preview-content').innerHTML = buildPreview();
  }
  goTo(currentStep);
}

let pendingDraft = null;
function resolveDraftRestore(restore) {
  const modal = document.getElementById('draft-restore-modal');
  const draft = pendingDraft;
  pendingDraft = null;
  if (modal) modal.hidden = true;
  if (restore && draft) {
    hydrateDraftState(draft.state);
    restoreDraftUI(draft);
    updateDraftStatus(draft.savedAt);
  } else {
    deleteDraft({silent: true});
    goTo(1);
  }
}

function showDraftRestorePrompt(draft) {
  const modal = document.getElementById('draft-restore-modal');
  if (!modal) return resolveDraftRestore(false);
  pendingDraft = draft;
  modal.hidden = false;
  requestAnimationFrame(() => modal.querySelector('.draft-restore-primary')?.focus());
}

function initDraftAutosave() {
  // 仕様上、自動保存・beforeunload保存は行わない。
}

function initDeliveryCalendar() {
  const input = document.getElementById('inp-date');
  if (!input) return;
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  input.min = [today.getFullYear(), String(today.getMonth() + 1).padStart(2, '0'), String(today.getDate()).padStart(2, '0')].join('-');
}

function formatCalendarDate(date) {
  const weekdays = ['日', '月', '火', '水', '木', '金', '土'];
  return `${date.getMonth() + 1}/${date.getDate()}（${weekdays[date.getDay()]}）`;
}

function toDateInputValue(date) {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}

function addWorkingDaysAfterRequest(date, businessDays) {
  const cursor = new Date(date.getFullYear(), date.getMonth(), date.getDate());
  if (isNonWorkingDeliveryDate(toDateInputValue(cursor))) return null;
  let count = 0;
  while (count < businessDays) {
    cursor.setDate(cursor.getDate() + 1);
    if (!isNonWorkingDeliveryDate(toDateInputValue(cursor))) count += 1;
  }
  return cursor;
}

const DELIVERY_CARD_TYPES = [
  { label: '2営業日案件', days: 2 },
  { label: '5営業日案件', days: 5 },
  { label: '7営業日案件', days: 7 },
  { label: '10営業日案件', days: 10 }
];

function renderTodayDeadline(today) {
  const container = document.getElementById('deadline-today');
  if (!container) return;
  const closed = isNonWorkingDeliveryDate(toDateInputValue(today));
  const liveSchedule = DELIVERY_SCHEDULE_BY_DATE.get(toDateInputValue(today));
  const exampleByDays = {
    2: '文言修正・人物変更・リサイズなどの軽微な修正',
    5: '新規作成・デザイン変更・季節変更などの中規模案件',
    7: '4デザイン以上・GIF 3デザイン以上・総枚数10枚以上などの大規模案件',
    10: '急募・料金表などの縦長画像、大型看板・複数デザインのポスターなどの特殊案件'
  };
  const cards = DELIVERY_CARD_TYPES.map(({ label, days }) => {
    const due = addWorkingDaysAfterRequest(today, days);
    const liveDue = liveSchedule ? liveSchedule[{ 5: 'five', 7: 'seven', 10: 'ten' }[days]] : '';
    const dueLabel = liveDue || (due ? formatCalendarDate(due) : '稼働日外');
    return `<article class="deadline-today-card${closed ? ' is-disabled' : ''}">
      <div class="deadline-today-label">${label}</div>
      <div class="deadline-today-term">通常納期</div>
      <div class="deadline-today-date">${dueLabel}</div>
      <div class="deadline-today-example">${exampleByDays[days]}</div>
    </article>`;
  }).join('');
  container.innerHTML = `<div class="deadline-today-heading">本日 ${formatCalendarDate(today)} に依頼した場合</div>${cards}`;
}

let deadlineCalendarExpanded = false;
function toggleDeadlineCalendar() { deadlineCalendarExpanded = !deadlineCalendarExpanded; renderDeadlineCalendar(); }
function renderDeadlineCalendar() {
  const body = document.getElementById('deadline-calendar-body');
  if (!body) return;
  const today = new Date();
  renderTodayDeadline(today);
  const rows = [];
  // 依頼日別カレンダーは、今日を含む直近14日分に絞って表示します。
  // 10営業日案件の納品日は上部の納期カードで確認できます。
  for (let offset = 0; offset < 14; offset += 1) {
    const requestDate = new Date(today.getFullYear(), today.getMonth(), today.getDate() + offset);
    const requestValue = toDateInputValue(requestDate);
    const closed = isNonWorkingDeliveryDate(requestValue);
    const liveSchedule = DELIVERY_SCHEDULE_BY_DATE.get(requestValue);
    const dueDates = [2, 5, 7, 10].map(days => {
      const due = addWorkingDaysAfterRequest(requestDate, days);
      const liveDue = liveSchedule ? liveSchedule[{ 5: 'five', 7: 'seven', 10: 'ten' }[days]] : '';
      return liveDue || (due ? formatCalendarDate(due) : '—');
    });
    const deadlineLabels = ['2営業日案件', '5営業日案件', '7営業日案件', '10営業日案件'];
    const dueCards = dueDates.map((value, index) => `<div class="deadline-day-card-item"><span>${deadlineLabels[index]}</span><strong>${value}</strong></div>`).join('');
    rows.push(`<section class="deadline-day-row ${closed ? 'is-non-working' : ''} ${offset === 0 ? 'is-today' : ''}">
      <div class="deadline-day-request"><span class="deadline-day-request-label">依頼日</span>${offset === 0 ? '<span class="deadline-today-badge">今日</span>' : ''}<strong>${formatCalendarDate(requestDate)}</strong></div>
      ${closed ? '<div class="deadline-day-closed">稼働日外</div>' : `<div class="deadline-day-cards">${dueCards}</div>`}
    </section>`);
  }
  body.innerHTML = rows.slice(0, deadlineCalendarExpanded ? rows.length : 7).join('');
  const moreButton = document.getElementById('deadline-calendar-more');
  if (moreButton) { moreButton.hidden = rows.length <= 7; moreButton.textContent = deadlineCalendarExpanded ? '表示を閉じる' : '今後の日程をさらに表示'; }
}

function applyCalendarApiData(payload) {
  if (!payload || !Array.isArray(payload.rows)) return;
  DELIVERY_SCHEDULE_BY_DATE.clear();
  payload.rows.forEach(row => {
    if (row?.date) DELIVERY_SCHEDULE_BY_DATE.set(row.date, row);
  });
  renderDeadlineCalendar();
}

function loadCalendarFromApi() {
  if (!CALENDAR_API_URL) return;
  const callbackName = `votecCalendarCallback_${Date.now()}`;
  const script = document.createElement('script');
  const separator = CALENDAR_API_URL.includes('?') ? '&' : '?';
  window[callbackName] = payload => {
    applyCalendarApiData(payload);
    delete window[callbackName];
    script.remove();
  };
  script.onerror = () => {
    delete window[callbackName];
    script.remove();
    console.warn('納期カレンダーAPIを取得できなかったため、内蔵カレンダーを使用します。');
  };
  script.src = `${CALENDAR_API_URL}${separator}callback=${callbackName}`;
  document.head.appendChild(script);
}

/* ========== INIT ========== */
function repairStaticJapaneseLabelsFinal() {
  const text = (selector, value) => { const el = document.querySelector(selector); if (el) el.textContent = value; };
  const label = (id, value) => { const el = document.querySelector(`#${id} .lbl`); if (el && el.firstChild) el.firstChild.nodeValue = `${value} `; };
  text('.header-logo span', 'デザインオーダー');
  ['依頼者', '画像種別', '媒体・サイズ', 'デザイン指示', '納期・指名', '確認・送信'].forEach((value, i) => text(`#l${i + 1}`, value));
  text('#p1 .ptitle', '依頼者情報');
  text('#p1 .psub', '支社・担当者情報を入力してください。支社を選ぶと担当営業者が絞り込まれます。');
  text('#p2 .ptitle', '画像種別・依頼内容');
  text('#p2 .psub', '画像の種類を選択してください。');
  text('#p3 .ptitle', '媒体・サイズ');
  text('#p3 .psub', '媒体を選び、必要な画像サイズを入力してください。');
  text('#p4 .ptitle', 'デザイン指示');
  text('#p4 .psub', '媒体・サイズの内容を確認し、デザインの指示を入力してください。');
  text('#p5 .ptitle', '納期・指名');
  text('#p6 .psub', '送信前に入力内容をご確認ください。');
  text('.submit-notice span', '送信することで利用規約に同意したものとみなします。');
  text('.submit-notice .terms-link', '利用規約を確認');
  const deliveryLabel = document.querySelector('#f-delivery .lbl');
  if (deliveryLabel && deliveryLabel.firstChild) deliveryLabel.firstChild.nodeValue = '納期希望 ';
  [['#rb-d1','希望なし（通常納期）'],['#rb-d2','事前予約分（通常納期）'],['#rb-d3','納期指定']].forEach(([selector, value]) => { const el = document.querySelector(selector); if (el) el.lastChild.textContent = value; });
  const deadlineTitle = document.querySelector('.deadline-guide-title');
  if (deadlineTitle) deadlineTitle.lastChild.nodeValue = '納期カレンダー';
  text('.deadline-calendar-intro', '今日依頼した場合の通常納期です。土日・祝日・会社休日を除いた営業日で計算しています。');
  text('.deadline-calendar-details summary', '今後の納期を確認');
  document.querySelectorAll('.deadline-calendar-table th').forEach((el, i) => { el.textContent = ['依頼日','2営業日','5営業日','7営業日','10営業日'][i] || el.textContent; });
  text('#blank-design-confirm-title', 'デザイン指示が入力されていません。');
  text('.blank-design-confirm-dialog p', 'おまかせでの依頼になりますが、よろしいですか？');
  text('.blank-design-confirm-secondary', '入力画面に戻る');
  text('.blank-design-confirm-primary', 'おまかせで進む');
  text('#p6 .ptitle', '内容確認・送信');
  const p2Heads = document.querySelectorAll('#p2 > .subhead');
  ['1 依頼内容', '2 店舗情報', '3 掲載URL'].forEach((value, i) => { if (p2Heads[i]) p2Heads[i].textContent = value; });
  const placeholders = {
    'inp-shop': '例：○○エステ 渋谷店',
    'inp-area': '例：東京都・渋谷',
    'inp-shopurl': '例：https://example.com/shop',
    'inp-shopurl2': 'ホームページURL（任意）',
    'inp-staff-other': '担当者名を入力',
    'inp-agent': '代理入力する方のお名前'
  };
  Object.entries(placeholders).forEach(([id, value]) => { const el = document.getElementById(id); if (el) el.placeholder = value; });
  document.querySelectorAll('#p2 label').forEach(el => { if (el.textContent.includes('URL')) el.lastChild.textContent = 'URLなし'; });
  document.querySelectorAll('.req').forEach(el => { el.textContent = '必須'; });
  document.querySelectorAll('.opt').forEach(el => { el.textContent = '任意'; });
  text('.info-card-head', 'お知らせ');
  text('.info-card.congestion .info-card-head', '現在の混雑状況');
  text('.congestion-label', '通常稼働');
  text('.congestion-sub', '標準的な対応状況です。');
  text('#btn-draft-save', '一時保存');
  text('#btn-draft-delete', '一時保存を削除');
  [['f-office','支社名'],['f-staff','営業担当者'],['f-client','フォーム記入者'],['f-agent','代理人名'],['f-email','記入者メールアドレス'],['f-imgtype','画像について'],['f-shop','店舗名'],['f-area','エリア（都道府県・市町村）'],['f-shopurl','掲載URL'],['f-shopurl2','ホームページURL'],['f-industry','業種'],['f-medium','媒体名']].forEach(([id, value]) => label(id, value));
  text('#f-medium .hint', '掲載する媒体をすべて選んでください。サイズは下の欄で設定します。');
  const offices = ['選択してください','東京本社','東京中央支社','池袋支社','北関東支社','東海支社','経営本部','北海道支社','関西支社','中四国支社','九州支社','南九州支部','A-Cloud','VOTEC','その他'];
  const office = document.getElementById('sel-office');
  if (office && !office.options[1]?.textContent.includes('東京')) office.innerHTML = offices.map((value, index) => `<option value="${escAttr(value)}"${index && index < 14 ? ` data-id="${index}"` : ''}>${value}</option>`).join('');
  const staff = document.getElementById('sel-staff');
  if (staff && !staff.options.length) staff.innerHTML = '<option value="">先に支社を選択</option>';
  if (staff && staff.options.length === 1) staff.options[0].textContent = '先に支社を選択';
  const clientLabels = [['rb-honin','本人','本人'],['rb-dairi','代理','代理']];
  clientLabels.forEach(([id, value, labelText]) => { const el = document.getElementById(id); if (el) { el.onclick = () => setClient(value); el.lastChild.textContent = labelText; } });
  [['rc-new','新規作成','新しくデザインを作成する'],['rc-fix','修正','過去に制作した画像の修正・変更・リサイズなど'],['rc-pay','有料案件','有料での制作']].forEach(([id, title, sub]) => { const el = document.getElementById(id); if (!el) return; const t = el.querySelector('.rcard-title'); const s = el.querySelector('.rcard-sub'); if (t) t.textContent = title; if (s) s.textContent = sub; });
  const industryValues = ['風俗','一般メンズエステ','カンパイワーク（女性）','カンパイワーク（男性）','その他'];
  document.querySelectorAll('#f-industry .rbtn').forEach((el, i) => { if (industryValues[i]) { el.textContent = industryValues[i]; el.onclick = () => setIndustry(industryValues[i], el); } });
  text('#btn-back', '戻る');
  text('#btn-next', '次へ');
}

// Final display repair layer.  The handoff HTML contains a few legacy mojibake
// literals; keep the underlying behaviour intact while normalising every visible
// label after each step is rendered.
function repairStaticJapaneseLabels() {
  const setText = (selector, value) => document.querySelectorAll(selector).forEach(el => { el.textContent = value; });
  const text = setText;
  const setLabel = (id, value) => { const el = document.querySelector(`#${id} .lbl`); if (el) { const badge = el.querySelector('.req,.opt'); el.textContent = value + ' '; if (badge) el.appendChild(badge); } };
  setText('.header-logo span', 'デザインオーダー');
  ['依頼者','画像種別','媒体・サイズ','デザイン指示','納期・指名','確認・送信'].forEach((v, i) => setText(`#step-${i + 1} .step-label`, v));
  setText('#p1 .ptitle', '依頼者'); setText('#p1 .psub', '依頼者情報を入力してください。');
  setText('#p2 .ptitle', '画像種別・依頼内容'); setText('#p2 .psub', '画像の種類と依頼内容を選択してください。');
  setText('#p3 .ptitle', '業種・媒体・サイズ'); setText('#p3 .psub', '業種・媒体を選び、必要な画像サイズを入力してください。');
  setText('#p4 .ptitle', 'デザイン指示'); setText('#p4 .psub', '媒体・サイズの内容を確認し、デザインの指示を入力してください。');
  setText('#p5 .ptitle', '納期・指名'); setText('#p5 .psub', '納期の希望と、指名するデザイナーを選択してください。');
  setText('#p6 .ptitle', '内容確認・送信'); setText('#p6 .psub', '送信前に入力内容をご確認ください。');
  setLabel('f-client','フォーム依頼者'); setLabel('f-agent','代理依頼者名'); setLabel('f-email','依頼者メールアドレス');
  setLabel('f-imgtype','画像について'); setLabel('f-shop','店舗名'); setLabel('f-area','エリア（都道府県・市町村）'); setLabel('f-shopurl','掲載URL'); setLabel('f-shopurl2','ホームページURL');
  setLabel('f-industry','業種'); setLabel('f-medium','媒体名'); setLabel('f-delivery','納期希望');
  document.querySelectorAll('.req').forEach(el => { el.textContent = '必須'; }); document.querySelectorAll('.opt').forEach(el => { el.textContent = '任意'; });
  const radios = [['rb-honin','本人'],['rb-dairi','代理']]; radios.forEach(([id, label]) => { const el = document.getElementById(id); if (el) el.lastChild.textContent = label; });
  [['rc-new','新規作成','新しくデザインを作成する','ポイント'],['rc-fix','修正','過去に制作した画像の修正・変更・リサイズなど','ポイント'],['rc-pay','有料案件','有料での制作','有料']].forEach(([id,title,sub,billing]) => { const el=document.getElementById(id); if(!el)return; const t=el.querySelector('.rcard-title'), s=el.querySelector('.rcard-sub'), b=el.querySelector('.rcard-billing'); if(t)t.textContent=title; if(s)s.textContent=sub; if(b)b.textContent=billing; });
  setText('#f-imgtype .err','画像種別を選択してください');
  setText('.imgtype-followup-kicker','追加設定'); setText('.imgtype-followup-head strong','有料案件の追加情報');
  const imgPay = document.querySelector('#f-pay-url .lbl'); if (imgPay) { const badge=imgPay.querySelector('.req,.opt'); imgPay.textContent='入稿URL '; if(badge)imgPay.appendChild(badge); }
  setText('#f-pay-url .hint','有料案件の入稿URLを入力してください'); setText('#f-pay-url .err','入稿URLを入力してください');
  const industries=['風俗','一般メンズエステ','カンパイワーク（女性）','カンパイワーク（男性）','その他'];
  document.querySelectorAll('#f-industry .rbtn').forEach((el,i)=>{ if(industries[i]){el.textContent=industries[i]; el.onclick=()=>setIndustry(industries[i],el);} });
  setText('#f-medium .hint','掲載する媒体をすべて選んでください。サイズは下の欄で設定します。');
  const imgCards=[['rc-new','新規作成','新しくデザインを作成する','ポイント'],['rc-fix','修正','過去に制作した画像の修正・変更・リサイズなど','ポイント'],['rc-pay','有料案件','有料での制作','有料']];
  const p2Heads=['1 依頼内容','2 店舗情報','3 掲載URL']; document.querySelectorAll('#p2 > .subhead').forEach((el,i)=>{if(p2Heads[i])el.textContent=p2Heads[i];});
  const ph={'inp-shop':'例：○○エステ 渋谷店','inp-area':'例：東京都・渋谷','inp-shopurl':'例：https://example.com/shop','inp-shopurl2':'ホームページURL（任意）','inp-staff-other':'担当者名を入力してください','inp-agent':'代理依頼者のお名前'}; Object.entries(ph).forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.placeholder=v;});
  document.querySelectorAll('#p2 .url-none-check span').forEach(el=>el.textContent='URLなし');
  const deliveryLabel=document.querySelector('#f-delivery .lbl'); if(deliveryLabel){const badge=deliveryLabel.querySelector('.req,.opt');deliveryLabel.textContent='納期希望 ';if(badge)deliveryLabel.appendChild(badge);}
  [['rb-d1','希望なし（通常納期）'],['rb-d2','事前予約分（通常納期）'],['rb-d3','納期指定']].forEach(([id,v])=>{const el=document.getElementById(id);if(el)el.lastChild.textContent=v;});
  setText('#f-delivery .err','納期希望を選択してください'); setText('#date-input .hint','社内稼働カレンダーを参照しています。稼働日外を避けて選択してください。');
  setText('.deadline-guide-title','納期カレンダー'); setText('.deadline-calendar-intro','今日依頼した場合の通常納期です。土日・祝日・会社休日を除いた営業日で計算しています。'); setText('.deadline-calendar-details summary','今後の納期を確認');
  document.querySelectorAll('.deadline-calendar-table th').forEach((el,i)=>{el.textContent=['依頼日','2営業日','5営業日','7営業日','10営業日'][i]||el.textContent;});
  const notes=['納期目安は依頼日の翌営業日から計算となります。','内容や稼働状況によって希望に添えない場合があります。','事前予約は130%期間のみの受付となります。']; document.querySelectorAll('#p5 .deadline-note-list li').forEach((el,i)=>{if(notes[i])el.textContent=notes[i];});
  text('.deadline-rate-note','※納期希望による請求ポイントの変動倍率については、下記をご参照ください。');
  const p5Fields=document.querySelectorAll('#p5 > .field'); if(p5Fields[1]){const l=p5Fields[1].querySelector(':scope > .lbl');if(l){const b=l.querySelector('.opt,.req');l.textContent='デザイナー指名 ';if(b)l.appendChild(b);}} setText('#p5 .select-stack .lbl',''); document.querySelectorAll('#p5 .select-stack > div > .lbl').forEach((el,i)=>el.textContent=`第${i+1}希望`); document.querySelectorAll('#p5 .select-stack option[value=""]').forEach(el=>el.textContent='選択してください');
  setText('#blank-design-confirm-title','デザイン指示が入力されていません'); setText('.blank-design-confirm-dialog p','おまかせでの依頼になりますが、よろしいですか？'); setText('.blank-design-confirm-secondary','入力画面に戻る'); setText('.blank-design-confirm-primary','おまかせで進む');
  setText('#btn-back','戻る'); setText('#btn-next','次へ'); setText('#btn-draft-save','一時保存'); setText('#btn-draft-delete','一時保存を削除');
  setText('.submit-notice span','送信することで利用規約に同意したものとみなします。'); setText('.terms-link','利用規約を確認');
  setText('.instruction-copy-label','画像別の指示');
}

function repairDynamicJapaneseLabels() {
  const labels=['雰囲気','デザイン要素・モチーフ']; document.querySelectorAll('.mood-group-label').forEach((el,i)=>{if(labels[i])el.textContent=labels[i];});
  const sections=['表現スタイル','装飾・モチーフ','色・光','テイスト']; document.querySelectorAll('.mood-section-label').forEach((el,i)=>{if(sections[i])el.textContent=sections[i];});
  document.querySelectorAll('.instruction-copy-label').forEach(el=>el.textContent='画像別の指示');
}

function repairVisibleLabels() {
  const t=(selector,value)=>document.querySelectorAll(selector).forEach(el=>{el.textContent=value;});
  const label=(id,value)=>{const el=document.querySelector(`#${id} .lbl`);if(!el)return;const b=el.querySelector('.req,.opt');el.textContent=value+' ';if(b)el.appendChild(b);};
  const J={
    logo:'\u30c7\u30b6\u30a4\u30f3\u30aa\u30fc\u30c0\u30fc',
    p1:'\u4f9d\u983c\u8005',p2:'\u753b\u50cf\u7a2e\u5225\u30fb\u4f9d\u983c\u5185\u5bb9',p3:'\u696d\u7a2e\u30fb\u5a92\u4f53\u30fb\u30b5\u30a4\u30ba',p4:'\u30c7\u30b6\u30a4\u30f3\u6307\u793a',p5:'\u7d0d\u671f\u30fb\u6307\u540d',p6:'\u5185\u5bb9\u78ba\u8a8d\u30fb\u9001\u4fe1',
    img:'\u753b\u50cf\u306b\u3064\u3044\u3066',new:'\u65b0\u898f\u4f5c\u6210',fix:'\u4fee\u6b63',pay:'\u6709\u6599\u6848\u4ef6',point:'\u30dd\u30a4\u30f3\u30c8',paid:'\u6709\u6599',
    shop:'\u5e97\u8217\u540d',area:'\u30a8\u30ea\u30a2\uff08\u90fd\u9053\u5e9c\u770c\u30fb\u5e02\u753a\u6751\uff09',url:'\u63b2\u8f09URL',url2:'\u30db\u30fc\u30e0\u30da\u30fc\u30b8URL',industry:'\u696d\u7a2e',medium:'\u5a92\u4f53\u540d',delivery:'\u7d0d\u671f\u5e0c\u671b',
    d1:'\u5e0c\u671b\u306a\u3057\uff08\u901a\u5e38\u7d0d\u671f\uff09',d2:'\u4e8b\u524d\u4e88\u7d04\u5206\uff08\u901a\u5e38\u7d0d\u671f\uff09',d3:'\u7d0d\u671f\u6307\u5b9a',
    back:'\u623b\u308b',next:'\u6b21\u3078',send:'\u9001\u4fe1\u3059\u308b',choose:'\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044'
  };
  t('.header-logo span',J.logo); ['\u4f9d\u983c\u8005','\u753b\u50cf\u7a2e\u5225','\u5a92\u4f53\u30fb\u30b5\u30a4\u30ba','\u30c7\u30b6\u30a4\u30f3\u6307\u793a','\u7d0d\u671f\u30fb\u6307\u540d','\u78ba\u8a8d\u30fb\u9001\u4fe1'].forEach((v,i)=>t(`#step-${i+1} .step-label`,v));
  t('#p1 .ptitle',J.p1);t('#p2 .ptitle',J.p2);t('#p3 .ptitle',J.p3);t('#p4 .ptitle',J.p4);t('#p5 .ptitle',J.p5);t('#p6 .ptitle',J.p6);
  label('f-imgtype',J.img);label('f-shop',J.shop);label('f-area',J.area);label('f-shopurl',J.url);label('f-shopurl2',J.url2);label('f-industry',J.industry);label('f-medium',J.medium);label('f-delivery',J.delivery);
  [['rc-new',J.new,'\u65b0\u3057\u304f\u30c7\u30b6\u30a4\u30f3\u3092\u4f5c\u6210\u3059\u308b',J.point],['rc-fix',J.fix,'\u904e\u53bb\u306b\u5236\u4f5c\u3057\u305f\u753b\u50cf\u306e\u4fee\u6b63\u30fb\u5909\u66f4\u30fb\u30ea\u30b5\u30a4\u30ba\u306a\u3069',J.point],['rc-pay',J.paid,'\u6709\u6599\u3067\u306e\u5236\u4f5c',J.paid]].forEach(([id,a,b,c])=>{const e=document.getElementById(id);if(!e)return;const x=e.querySelector('.rcard-title'),y=e.querySelector('.rcard-sub'),z=e.querySelector('.rcard-billing');if(x)x.textContent=a;if(y)y.textContent=b;if(z)z.textContent=c;});
  const inds=['\u98a8\u4fd7','\u4e00\u822c\u30e1\u30f3\u30ba\u30a8\u30b9\u30c6','\u30ab\u30f3\u30d1\u30a4\u30ef\u30fc\u30af\uff08\u5973\u6027\uff09','\u30ab\u30f3\u30d1\u30a4\u30ef\u30fc\u30af\uff08\u7537\u6027\uff09','\u305d\u306e\u4ed6'];document.querySelectorAll('#f-industry .rbtn').forEach((e,i)=>{if(inds[i]){e.textContent=inds[i];e.onclick=()=>setIndustry(inds[i],e);}});
  [['#rb-d1',J.d1,'希望なし'],['#rb-d2',J.d2,'事前予約'],['#rb-d3',J.d3,'納期指定']].forEach(([s,v,stateValue])=>{const e=document.querySelector(s);if(e){e.lastChild.textContent=v;e.onclick=()=>setDelivery(stateValue);}});
  t('.rcard-billing',J.point);const paid=document.querySelector('#rc-pay .rcard-billing');if(paid)paid.textContent=J.paid;t('#btn-back',J.back);t('#btn-next',J.next);t('.instruction-copy-label','\u753b\u50cf\u5225\u306e\u6307\u793a');t('.req','\u5fc5\u9808');t('.opt','\u4efb\u610f');
  document.querySelectorAll('.design-label-row').forEach(el=>{const badge=el.querySelector('.req,.opt');if(badge){badge.classList.remove('req');badge.classList.add('opt');badge.textContent='\u4efb\u610f';}});
  document.querySelectorAll('#p2 .url-none-check').forEach(el=>{const input=el.querySelector('input');if(!input)return;el.replaceChildren(input);const span=document.createElement('span');span.textContent='\u0055\u0052\u004c\u306a\u3057';el.appendChild(span);});
  ['\u96f0\u56f2\u6c17','\u30c7\u30b6\u30a4\u30f3\u8981\u7d20\u30fb\u30e2\u30c1\u30fc\u30d5'].forEach((v,i)=>{const e=document.querySelectorAll('.mood-group-label')[i];if(e)e.textContent=v;});
  ['\u8868\u73fe\u30b9\u30bf\u30a4\u30eb','\u88c5\u98fe\u30fb\u30e2\u30c1\u30fc\u30d5','\u8272\u30fb\u5149','\u30c6\u30a4\u30b9\u30c8'].forEach((v,i)=>{const e=document.querySelectorAll('.mood-section-label')[i];if(e)e.textContent=v;});
  document.querySelectorAll('#p5 .select-stack > div > .lbl').forEach((e,i)=>e.textContent=`\u7b2c${i+1}\u5e0c\u671b`);document.querySelectorAll('#p5 .select-stack option[value=""]').forEach(e=>e.textContent=J.choose);
  // Final pass for the remaining static headings and helper text.  These values
  // are intentionally escaped so the repair layer itself cannot be corrupted by
  // the legacy mojibake strings still present in the handoff HTML.
  const subheads={
    '#p1 .psub':'\u4f9d\u983c\u8005\u60c5\u5831\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    '#p2 .psub':'\u753b\u50cf\u306e\u7a2e\u985e\u3068\u4f9d\u983c\u5185\u5bb9\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    '#p3 .psub':'\u696d\u7a2e\u30fb\u5a92\u4f53\u3092\u9078\u3073\u3001\u5fc5\u8981\u306a\u753b\u50cf\u30b5\u30a4\u30ba\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    '#p4 .psub':'\u5a92\u4f53\u30fb\u30b5\u30a4\u30ba\u306e\u5185\u5bb9\u3092\u78ba\u8a8d\u3057\u3001\u30c7\u30b6\u30a4\u30f3\u306e\u6307\u793a\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    '#p5 .psub':'\u7d0d\u671f\u306e\u5e0c\u671b\u3068\u3001\u6307\u540d\u3059\u308b\u30c7\u30b6\u30a4\u30ca\u30fc\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002',
    '#p6 .psub':'\u9001\u4fe1\u524d\u306b\u5165\u529b\u5185\u5bb9\u3092\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002'
  }; Object.entries(subheads).forEach(([s,v])=>t(s,v));
  t('#p4 .instruction-group-toolbar .lbl','\u753b\u50cf\u3054\u3068\u306e\u5236\u4f5c\u6307\u793a');
  t('#p4 .instruction-group-toolbar .hint','\u5a92\u4f53\u30fb\u30b5\u30a4\u30ba\u3092\u9078\u3073\u3001\u5236\u4f5c\u753b\u50cf\u3054\u3068\u306b\u6307\u793a\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044\u3002\u540c\u3058\u5185\u5bb9\u306f\u5165\u529b\u5f8c\u306b\u4ed6\u306e\u753b\u50cf\u3078\u9069\u7528\u3067\u304d\u307e\u3059\u3002');
  t('#p4 .instruction-reset-all','\u3059\u3079\u3066\u306e\u753b\u50cf\u306e\u6307\u793a\u3092\u30ea\u30bb\u30c3\u30c8');
  t('#f-delivery .rbtn:nth-child(1)','\u5e0c\u671b\u306a\u3057\uff08\u901a\u5e38\u7d0d\u671f\uff09');
  t('#f-delivery .rbtn:nth-child(2)','\u4e8b\u524d\u4e88\u7d04\u5206\uff08\u901a\u5e38\u7d0d\u671f\uff09');
  t('#f-delivery .rbtn:nth-child(3)','\u7d0d\u671f\u6307\u5b9a');
  t('#date-input .hint','\u793e\u5185\u7a3c\u50cd\u30ab\u30ec\u30f3\u30c0\u30fc\u3092\u53c2\u7167\u3057\u3066\u3044\u307e\u3059\u3002\u7a3c\u50cd\u65e5\u5916\u3092\u907f\u3051\u3066\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044\u3002');
  t('.deadline-guide-title','\u7d0d\u671f\u30ab\u30ec\u30f3\u30c0\u30fc');
  t('.deadline-calendar-intro','\u4eca\u65e5\u4f9d\u983c\u3057\u305f\u5834\u5408\u306e\u901a\u5e38\u7d0d\u671f\u3067\u3059\u3002\u571f\u65e5\u30fb\u795d\u65e5\u30fb\u4f1a\u793e\u4f11\u65e5\u3092\u9664\u3044\u305f\u55b6\u696d\u65e5\u3067\u8a08\u7b97\u3057\u3066\u3044\u307e\u3059\u3002');
  t('.deadline-calendar-details summary','\u4eca\u5f8c\u306e\u7d0d\u671f\u3092\u78ba\u8a8d');
  const deliveryNotes=['\u7d0d\u671f\u76ee\u5b89\u306f\u4f9d\u983c\u65e5\u306e\u7fcc\u55b6\u696d\u65e5\u304b\u3089\u8a08\u7b97\u3068\u306a\u308a\u307e\u3059\u3002','\u5185\u5bb9\u3084\u7a3c\u50cd\u72b6\u6cc1\u306b\u3088\u3063\u3066\u5e0c\u671b\u306b\u6cbf\u3048\u306a\u3044\u5834\u5408\u304c\u3042\u308a\u307e\u3059\u3002','\u4e8b\u524d\u4e88\u7d04\u306f130%\u671f\u9593\u306e\u307f\u306e\u53d7\u4ed8\u3068\u306a\u308a\u307e\u3059\u3002']; document.querySelectorAll('#p5 .deadline-note-list li').forEach((e,i)=>{if(deliveryNotes[i])e.textContent=deliveryNotes[i];});
  const designerField=document.querySelector('#p5 > .field[style*="margin-top"]'); if(designerField){const l=designerField.querySelector(':scope > .lbl'); if(l){const b=l.querySelector('.req,.opt'); l.textContent='\u30c7\u30b6\u30a4\u30ca\u30fc\u6307\u540d '; if(b)l.appendChild(b);} const h=designerField.querySelector(':scope > .hint'); if(h)h.textContent='\u6307\u540d\u306f\u4efb\u610f\u3067\u3059\u3002\u7b2c1\u5e0c\u671b\u306e\u307f\u306e\u6307\u5b9a\u3082\u3067\u304d\u307e\u3059\u3002';}
  t('#p6 .submit-notice span','\u9001\u4fe1\u3059\u308b\u3053\u3068\u3067\u5229\u7528\u898f\u7d04\u306b\u540c\u610f\u3057\u305f\u3082\u306e\u3068\u307f\u306a\u3057\u307e\u3059\u3002'); t('#p6 .terms-link','\u5229\u7528\u898f\u7d04\u3092\u78ba\u8a8d');
  t('#p-success .stitle','\u4f9d\u983c\u3092\u9001\u4fe1\u3057\u307e\u3057\u305f');
  t('#p-success .ssub','\u30d0\u30c3\u30af\u30ed\u30b0\u306b\u4f9d\u983c\u5185\u5bb9\u3092\u767b\u9332\u3057\u307e\u3057\u305f\u3002\u30c7\u30b6\u30a4\u30ca\u30fc\u304b\u3089\u78ba\u8a8d\u306e\u9023\u7d61\u304c\u3042\u308b\u5834\u5408\u306f\u3054\u5bfe\u5fdc\u3092\u304a\u9858\u3044\u3057\u307e\u3059\u3002');
  // Inputs and validation messages that are not represented by a visible field
  // label also need to be normalised (notably the "その他" fallbacks in steps 2–3).
  const placeholders={
    '#inp-industry-other':'\u696d\u7a2e\u540d\u3092\u5165\u529b',
    '#inp-medium-other':'\u5a92\u4f53\u540d\u3092\u5165\u529b',
    '#inp-shop':'\u4f8b\uff1a\u3007\u3007\u30a8\u30b9\u30c6 \u6e0b\u8c37\u5e97',
    '#inp-area':'\u4f8b\uff1a\u6771\u4eac\u90fd\u30fb\u6e0b\u8c37',
    '#inp-shopurl':'\u4f8b\uff1ahttps://example.com/shop',
    '#inp-shopurl2':'\u30db\u30fc\u30e0\u30da\u30fc\u30b8URL\uff08\u4efb\u610f\uff09'
  }; Object.entries(placeholders).forEach(([s,v])=>{const e=document.querySelector(s);if(e)e.placeholder=v;});
  const errors={
    '#f-industry-other .err':'\u696d\u7a2e\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-industry > .err':'\u696d\u7a2e\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-medium-other .err':'\u5a92\u4f53\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-shop .err':'\u5e97\u8217\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-area .err':'\u30a8\u30ea\u30a2\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-shopurl .err':'\u63b2\u8f09URL\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044',
    '#f-medium .err':'\u5a92\u4f53\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044'
  }; Object.entries(errors).forEach(([s,v])=>t(s,v));
  label('f-medium-other','\u5a92\u4f53\u540d\uff08\u305d\u306e\u4ed6\uff09');
  t('#f-medium-other .hint','\u300c\u305d\u306e\u4ed6\u300d\u3092\u9078\u3093\u3060\u5834\u5408\u306f\u3001\u5a92\u4f53\u540d\u3092\u76f4\u63a5\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044');
  t('#f-office .err','\u652f\u793e\u3092\u9078\u629e\u3057\u3066\u304f\u3060\u3055\u3044');
  t('#f-staff .err','\u55b6\u696d\u62c5\u5f53\u8005\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044');
  t('#f-agent .err','\u4ee3\u7406\u8005\u540d\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044');
  t('#f-email .err','\u6709\u52b9\u306a\u30e1\u30fc\u30eb\u30a2\u30c9\u30ec\u30b9\u3092\u5165\u529b\u3057\u3066\u304f\u3060\u3055\u3044');
  t('#draft-restore-title','\u4e00\u6642\u4fdd\u5b58\u3057\u305f\u4f9d\u983c\u5185\u5bb9\u304c\u3042\u308a\u307e\u3059\u3002');
  t('#draft-restore-modal .draft-restore-dialog > p','\u5165\u529b\u5185\u5bb9\u3092\u5fa9\u5143\u3057\u307e\u3059\u304b\uff1f');
  t('#draft-restore-modal .draft-file-notice','\u6dfb\u4ed8\u30d5\u30a1\u30a4\u30eb\u306f\u4e00\u6642\u4fdd\u5b58\u3055\u308c\u307e\u305b\u3093\u3002\u9001\u4fe1\u524d\u306b\u518d\u5ea6\u3054\u78ba\u8a8d\u304f\u3060\u3055\u3044\u3002');
  t('#draft-restore-modal .draft-restore-new','\u65b0\u3057\u304f\u5165\u529b\u3059\u308b');
  t('#draft-restore-modal .draft-restore-primary','\u5fa9\u5143\u3059\u308b');
}

function initDesigners() {
  ['sel-des1', 'sel-des2', 'sel-des3'].forEach(id => {
    const select = document.getElementById(id);
    if (!select) return;
    select.innerHTML = '<option value="">選択しない</option>' +
      Object.entries(designerGroups).map(([areaName, designers]) => `
        <optgroup label="${areaName}">
          ${designers.map(designerName => `<option value="${designerName}">${designerName}</option>`).join('')}
        </optgroup>
      `).join('');
  });
}

const restoredDraft = readDraft();
  repairStaticJapaneseLabelsFinal();
repairVisibleLabels();
initCongestion();
initNotices();
initDesigners();
initDeliveryCalendar();
renderDeadlineCalendar();
loadCalendarFromApi();
relocateIndustryAndAddProductionType();
renderCommonBlock();
// 新規入力時は「希望なし」を初期選択にし、保存済みの指定は復元時に優先する。
if (!restoredDraft && !state.delivery) {
  state.delivery = '希望なし';
  ['d1', 'd2', 'd3'].forEach(id => document.getElementById('rb-' + id)?.classList.remove('sel'));
  document.getElementById('rb-d1')?.classList.add('sel');
  const dateInput = document.getElementById('date-input');
  if (dateInput) dateInput.style.display = 'none';
}
if (!restoredDraft) {
  state.delivery = '\u5e0c\u671b\u306a\u3057';
  ['d1', 'd2', 'd3'].forEach(id => document.getElementById('rb-' + id)?.classList.remove('sel'));
  document.getElementById('rb-d1')?.classList.add('sel');
  const defaultDateInput = document.getElementById('date-input');
  if (defaultDateInput) defaultDateInput.style.display = 'none';
}
if (restoredDraft) {
  goTo(1);
  showDraftRestorePrompt(restoredDraft);
} else {
  goTo(currentStep);
}
initDraftAutosave();
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeMobileMediaMenu();
});
window.addEventListener('resize', () => {
  if (window.innerWidth > 600) closeMobileMediaMenu();
});

function placeAdvancedInstructionsAfterDesign(root) {
  const split = root.querySelector('.instruction-text-split');
  const advanced = root.querySelector('.advanced-instructions');
  if (split && advanced && advanced.parentElement !== split) split.appendChild(advanced);
}

function normalizeOptionalInstructionLabels(root) {
  root.querySelectorAll('.instruction-text-part:first-child .req').forEach(badge => {
    if (badge.className !== 'opt') badge.className = 'opt';
    if (badge.textContent !== '任意') badge.textContent = '任意';
  });
}

function enforceOptionalDesignLabel(root) {
  root.querySelectorAll('.design-label-row .req, .design-label-row .opt').forEach(badge => {
    if (badge.className !== 'opt') badge.className = 'opt';
    if (badge.textContent !== '\u4efb\u610f') badge.textContent = '\u4efb\u610f';
  });
}

const instructionLayoutObserver = new MutationObserver(() => {
  document.querySelectorAll('.design-instruction-block').forEach(root => {
    placeAdvancedInstructionsAfterDesign(root);
    normalizeOptionalInstructionLabels(root);
    enforceOptionalDesignLabel(root);
  });
});
instructionLayoutObserver.observe(document.body, { childList: true, subtree: true });
document.querySelectorAll('.design-instruction-block').forEach(root => {
  placeAdvancedInstructionsAfterDesign(root);
  normalizeOptionalInstructionLabels(root);
  enforceOptionalDesignLabel(root);
});

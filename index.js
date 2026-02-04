// 설정: 환경 변수(Railway 등) 우선, 없으면 config.json 사용
let config = {
  token: process.env.DISCORD_TOKEN,
  gemini_api_key: process.env.GEMINI_API_KEY || ''
};
try {
  const fileConfig = require('./config.json');
  config.token = config.token || fileConfig.token;
  config.gemini_api_key = config.gemini_api_key || fileConfig.gemini_api_key || '';
} catch (e) {
  // config.json 없음 (배포 환경에서는 환경 변수만 사용)
}
if (!config.token) {
  console.error('DISCORD_TOKEN 환경 변수 또는 config.json의 token이 필요합니다.');
  process.exit(1);
}

const { Client, GatewayIntentBits, EmbedBuilder, ChannelType } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./database');

// 땅굴 진행용 스레드 (userId -> { threadId, channelId })
const dungeonThreads = new Map();

// Gemini API 초기화
let genAI = null;
if (config.gemini_api_key && config.gemini_api_key.trim() !== '') {
  try {
    genAI = new GoogleGenerativeAI(config.gemini_api_key);
  } catch (error) {
    console.error('Gemini API 초기화 오류:', error.message || error);
    genAI = null;
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages
  ]
});

client.once('clientReady', () => {
  console.log(`봇이 로그인했습니다: ${client.user.tag}`);
});

// 출석 보상 계산
function calculateAttendanceReward() {
  const rand = Math.random() * 100;
  
  if (rand < 1) return 2000; // 1% 확률
  if (rand < 6) return 500;  // 5% 확률 (1~5%)
  if (rand < 11) return 50;  // 5% 확률 (6~10%)
  return 100; // 기본
}

// 잡동사니 (탐험 확률 %, 던전에서는 2배 확률로 적용)
const junkItems = [
  { name: '동전', emoji: '🪙', price: 500, rate: 1 },
  { name: '작은열매', emoji: '🍓', price: 100, rate: 20 },
  { name: '도토리', emoji: '🌰', price: 150, rate: 15 },
  { name: '들꽃', emoji: '🌸', price: 10, rate: 30 },
  { name: '나비날개', emoji: '🦋', price: 300, rate: 5 },
  { name: '깃털', emoji: '🪶', price: 200, rate: 10 }
];
function rollJunkItemOnce() {
  const roll = Math.random() * 100;
  let acc = 0;
  for (const j of junkItems) {
    acc += j.rate;
    if (roll < acc) return j.name;
  }
  return null;
}

function rollJunkForExploration() {
  return rollJunkItemOnce();
}

function rollJunkForDungeon() {
  const results = [];
  const a = rollJunkItemOnce();
  const b = rollJunkItemOnce();
  if (a) results.push(a);
  if (b) results.push(b);
  return results;
}

// 탐험 보상 계산
function calculateExplorationReward() {
  const dustRand = Math.random() * 100;
  let dust;
  if (dustRand < 2) dust = 5000;
  else dust = Math.floor(Math.random() * 901) + 100;
  
  const itemRand = Math.random() * 100;
  let item = null;
  if (itemRand < 5) {
    const items = ['랜덤박스', '조약돌', '나무열매', '모험기록'];
    item = items[Math.floor(Math.random() * items.length)];
  }
  const junk = rollJunkForExploration();
  return { dust, item, junk };
}

// Gemini API로 탐험 코멘트 생성
async function generateExplorationComment() {
  if (!genAI) {
    const defaultComments = [
      '나뭇잎이 흩어진 숲길을 걸었습니다.',
      '작은 골목을 탐험했습니다.',
      '땅굴 입구를 찾았습니다.',
      '뱀이 지나간 자리를 봤습니다.',
      '고양이의 발자국을 발견했습니다.',
      '덤불 속에서 수상한 소리가 들립니다.',
      '뱀 허물이 구석진 곳에서 반짝입니다.',
      '까마귀가 푸드덕 날아갑니다.'
    ];
    return defaultComments[Math.floor(Math.random() * defaultComments.length)];
  }
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = '작은 생물이 자연을 탐험하는 내용을 80자 이내로 간단하고 재미있게 묘사해주세요. 한국어로 작성해주세요.';
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();
    
    // 80자 제한
    if (text.length > 80) {
      text = text.substring(0, 77) + '...';
    }
    
    return text;
  } catch (error) {
    const msg = (error && typeof error.message === 'string' ? error.message : '') || String(error);
    const full = msg + String(error);
    const isQuota = /429|quota|Too Many Requests/i.test(full);
    if (isQuota) {
      console.warn('[Gemini] 할당량 초과로 기본 코멘트 사용 (탐험). 잠시 후 재시도되거나 결제/플랜을 확인하세요.');
    } else {
      console.error('Gemini API 오류:', msg);
    }
    const defaultComments = [
      '나뭇잎이 흩어진 숲길을 걸었습니다.',
      '작은 골목을 탐험했습니다.',
      '빗물이 고인 웅덩이를 발견했습니다.',
      '땅굴 입구를 찾았습니다.',
      '뱀이 지나간 자리를 봤습니다.',
      '멧쥐가 먹다 남긴 나뭇열매를 찾았습니다.',
      '고양이의 발자국을 발견했습니다.',
      '덤불 속에서 수상한 소리가 들립니다.',
      '뱀 허물이 구석진 곳에서 반짝입니다.',
      '까마귀가 푸드덕 날아갑니다.'
    ];
    return defaultComments[Math.floor(Math.random() * defaultComments.length)];
  }
}

// 무기 강화 확률 계산
function calculateEnhancementChance(currentLevel) {
  if (currentLevel < 5) return 0.7;      // 70%
  if (currentLevel < 10) return 0.5;     // 50%
  if (currentLevel < 15) return 0.2;     // 20%
  if (currentLevel < 20) return 0.1;     // 10%
  return 0;
}

// 무기 강화 비용 계산
function getEnhancementCost(currentLevel) {
  if (currentLevel < 5) return 10;
  if (currentLevel < 10) return 20;
  if (currentLevel < 15) return 50;
  if (currentLevel < 20) return 100;
  return 0;
}

// 중복 실행 방지를 위한 처리 중 플래그
const processingMessages = new Set();

client.on('messageCreate', async (message) => {
  if (message.author.bot) return;
  const first = message.content[0];
  if (first !== '!' && first !== '\uFF01') return; // 반각/전각 !

  // 중복 실행 방지
  const messageKey = `${message.id}-${message.author.id}`;
  if (processingMessages.has(messageKey)) {
    return;
  }
  processingMessages.add(messageKey);

  // 5초 후 플래그 제거 (타임아웃 방지)
  setTimeout(() => {
    processingMessages.delete(messageKey);
  }, 5000);

  let command = message.content.split(/\s+/)[0];
  if (command.startsWith('\uFF01')) command = '!' + command.slice(1); // 전각 ! → 반각
  command = command.toLowerCase();
  const args = message.content.slice(message.content.split(/\s+/)[0].length).trim().split(/\s+/).filter(Boolean);

  try {
    switch (command) {
      case '!출석':
        await handleAttendance(message);
        break;
      case '!탐험':
        await handleExploration(message);
        break;
      case '!가방':
        await handleInventory(message);
        break;
      case '!캐릭터':
        if (args.length > 0 && args[0] === '수정') {
          await handleCharacterRename(message, args.slice(1));
        } else {
          await handleCharacter(message);
        }
        break;
      case '!무기':
        await handleWeapon(message);
        break;
      case '!무기장착':
        await handleEquipWeapon(message, args);
        break;
      case '!무기강화':
        await handleEnhanceWeapon(message);
        break;
      case '!보내기':
        await handleSend(message, args);
        break;
      case '!지급':
        await handleGive(message, args);
        break;
      case '!배틀':
        await handleBattle(message, args);
        break;
      case '!상점':
        await handleShop(message);
        break;
      case '!구매':
        await handleBuy(message, args);
        break;
      case '!판매':
        await handleSell(message, args);
        break;
      case '!박스열기':
        await handleOpenRandomBox(message);
        break;
      case '!사용':
        await handleUseItem(message, args);
        break;
      case '!도움말':
        await handleHelp(message);
        break;
      case '!회복':
        await handleHeal(message);
        break;
      case '!땅굴':
        if (args[0] === '탈출') {
          await handleDungeonExit(message);
        } else if (db.isInDungeon(message.author.id)) {
          await handleDungeonExplore(message);
        } else {
          await handleDungeon(message);
        }
        break;
    }
  } catch (error) {
    console.error('명령어 처리 오류:', error);
    message.reply('명령어 처리 중 오류가 발생했습니다.');
  } finally {
    // 처리 완료 후 플래그 제거
    processingMessages.delete(messageKey);
  }
});

// 출석 처리 (하루 1회만 가능, 중복 요청 방지)
async function handleAttendance(message) {
  const userId = message.author.id;
  const today = new Date().toISOString().split('T')[0];
  const user = db.getOrCreateUser(userId);
  const lastDate = user.last_attendance_date == null ? '' : String(user.last_attendance_date);
  
  if (lastDate === today) {
    return message.reply('오늘은 이미 출석했습니다!');
  }
  
  // 보상 지급 전에 먼저 출석일 기록 (중복 출석 방지)
  db.setAttendance(userId, today);
  
  const character = db.getOrCreateCharacter(userId);
  const reward = calculateAttendanceReward();
  db.addDust(userId, reward);
  
  const updatedUser = db.getOrCreateUser(userId);
  const displayDust = Math.max(0, updatedUser.dust || 0);
  
  const embed = new EmbedBuilder()
    .setTitle('출석 완료!')
    .setDescription(`${character.name}이(가) 나뭇잎 길드에 모습을 보였습니다.\n\n${reward}닢을 획득했습니다!\n\n보유 닢: ${displayDust}닢`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 탐험 처리
async function handleExploration(message) {
  const userId = message.author.id;
  const today = new Date().toISOString().split('T')[0];
  const user = db.getOrCreateUser(userId);
  
  // 날짜 체크 및 리셋
  if (user.last_exploration_date !== today) {
    db.resetExplorationCount(userId);
  }
  
  // 탐험 횟수 체크
  const userCheck = db.getOrCreateUser(userId);
  if (userCheck.exploration_count >= 3) {
    return message.reply('오늘의 탐험 횟수를 모두 사용했습니다! (하루 3회)');
  }
  
  // 탐험 실행
  db.incrementExploration(userId);
  const reward = calculateExplorationReward();
  
  // 먼지는 항상 획득
  db.addDust(userId, reward.dust);
  
  if (reward.item) db.addItem(userId, reward.item, 'item');
  if (reward.junk) db.addItem(userId, reward.junk, 'item', 1);
  
  const levelResult = db.addExp(userId, 1);
  const explorationComment = await generateExplorationComment();
  const updatedUser = db.getOrCreateUser(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('탐험 완료!')
    .setColor(0x0099FF)
    .setTimestamp();
  
  let description = `📖 ${explorationComment}\n\n`;
  description += `💰 ${reward.dust}닢을 획득했습니다!\n`;
  if (reward.item) description += `📦 ${reward.item}을(를) 획득했습니다!\n`;
  if (reward.junk) {
    const j = junkItems.find(x => x.name === reward.junk);
    description += `${j ? j.emoji : '🪙'} ${reward.junk}을(를) 주웠습니다!\n`;
  }
  description += `✨ 경험치 +1\n`;
  description += `\n보유 닢: ${Math.max(0, updatedUser.dust || 0)}닢\n`;
  
  if (levelResult.leveledUp) {
    description += `\n🎉 레벨업! 레벨 ${levelResult.oldLevel} → ${levelResult.newLevel}`;
    embed.setColor(0xFFD700);
  }
  
  embed.setDescription(description);
  message.reply({ embeds: [embed] });
}

// 가방 처리 (채널에 출력)
async function handleInventory(message) {
  const userId = message.author.id;
  const inventory = db.getInventory(userId);
  const user = db.getOrCreateUser(userId);
  const weapon = db.getWeapon(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('📦 가방')
    .setColor(0x9B59B6)
    .setTimestamp();
  
  const displayDust = Math.max(0, user.dust || 0);
  let description = `보유 닢: ${displayDust}닢\n\n`;
  
  if (weapon) {
    const weaponNames = { '가시': '🌵 가시', '껍질': '🛡️ 껍질' };
    description += `**장착 무기**\n${weaponNames[weapon.weapon_type] || weapon.weapon_type} (+${weapon.enhancement}강)\n\n`;
  }
  
  const weaponItems = inventory.filter(item => ['가시', '껍질'].includes(item.item_name));
  if (weaponItems.length > 0) {
    description += '**보유 무기**\n';
    weaponItems.forEach(item => {
      const emojis = { '가시': '🌵', '껍질': '🛡️' };
      description += `${emojis[item.item_name] || ''} **${item.item_name}** x${item.quantity}\n`;
    });
    description += '\n';
  }
  
  const regularItems = inventory.filter(item => !['가시', '껍질'].includes(item.item_name));
  
  description += '**보유 아이템**\n';
  if (regularItems.length === 0 && weaponItems.length === 0) {
    description += '아이템이 없습니다.';
  } else if (regularItems.length === 0) {
    description += '일반 아이템이 없습니다.';
  } else {
    regularItems.forEach(item => {
      description += `**${item.item_name}** x${item.quantity}\n`;
    });
  }
  
  embed.setDescription(description);
  await message.reply({ embeds: [embed] });
}

// 캐릭터 정보 표시
async function handleCharacter(message) {
  const userId = message.author.id;
  const character = db.getOrCreateCharacter(userId);
  const user = db.getOrCreateUser(userId);
  const weapon = db.getWeapon(userId);
  
  let attackBonus = 0;
  let defenseBonus = 0;
  if (weapon) {
    const bonus = weapon.enhancement * 2;
    if (weapon.weapon_type === '가시') attackBonus = bonus;
    else if (weapon.weapon_type === '껍질') defenseBonus = bonus;
  }
  
  const embed = new EmbedBuilder()
    .setTitle(`👤 ${character.name}`)
    .addFields(
      { name: '레벨', value: `${character.level}`, inline: true },
      { name: '경험치', value: `${character.exp}/${(character.level + 1) * 5}`, inline: true },
      { name: '닢', value: `${Math.max(0, user.dust || 0)}`, inline: true },
      { name: '체력', value: `${character.current_hp}/${character.max_hp}`, inline: true },
      { name: '공격력', value: `${character.attack + attackBonus}${attackBonus > 0 ? ` (+${attackBonus})` : ''}`, inline: true },
      { name: '방어력', value: `${character.defense + defenseBonus}${defenseBonus > 0 ? ` (+${defenseBonus})` : ''}`, inline: true }
    )
    .setColor(0x3498DB)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 캐릭터 이름 수정
async function handleCharacterRename(message, args) {
  if (args.length === 0) {
    return message.reply('사용법: `!캐릭터 수정 [새로운 이름]`');
  }
  
  const newName = args.join(' ');
  
  // 이름 길이 제한 (예: 20자)
  if (newName.length > 20) {
    return message.reply('이름은 20자 이하여야 합니다.');
  }
  
  const userId = message.author.id;
  db.updateCharacterName(userId, newName);
  
  const embed = new EmbedBuilder()
    .setTitle('캐릭터 이름 변경 완료!')
    .setDescription(`캐릭터 이름이 **${newName}**으로 변경되었습니다.`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 무기 정보 표시
async function handleWeapon(message) {
  const userId = message.author.id;
  const weapon = db.getWeapon(userId);
  
  if (!weapon) {
    return message.reply('장착한 무기가 없습니다. `!무기장착 [가시/껍질]` 명령어로 무기를 장착하세요.');
  }
  const weaponNames = { '가시': '🌵 가시', '껍질': '🛡️ 껍질' };
  const statNames = { '가시': '공격력', '껍질': '방어력' };
  
  const bonus = weapon.enhancement * 2;
  
  const embed = new EmbedBuilder()
    .setTitle('무기 정보')
    .addFields(
      { name: '무기', value: weaponNames[weapon.weapon_type] || weapon.weapon_type, inline: true },
      { name: '강화', value: `+${weapon.enhancement}`, inline: true },
      { name: '보너스', value: `${statNames[weapon.weapon_type]} +${bonus}`, inline: true }
    )
    .setColor(0xE67E22)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 무기 장착
async function handleEquipWeapon(message, args) {
  const userId = message.author.id;
  
  if (args.length < 1) {
    return message.reply('사용법: `!무기장착 [가시/껍질]`');
  }
  
  const weaponType = args[0];
  const validTypes = ['가시', '껍질'];
  if (!validTypes.includes(weaponType)) {
    return message.reply('올바른 무기 종류를 입력하세요: 가시, 껍질');
  }
  
  db.equipWeapon(userId, weaponType);
  const weaponNames = { '가시': '🌵 가시', '껍질': '🛡️ 껍질' };
  
  const embed = new EmbedBuilder()
    .setTitle('무기 장착 완료!')
    .setDescription(`${weaponNames[weaponType]}을(를) 장착했습니다.`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 무기 강화
async function handleEnhanceWeapon(message) {
  const userId = message.author.id;
  const weapon = db.getWeapon(userId);
  
  if (!weapon) {
    return message.reply('장착한 무기가 없습니다.');
  }
  
  if (weapon.enhancement >= 20) {
    return message.reply('이미 최대 강화 단계입니다! (+20)');
  }
  
  const cost = getEnhancementCost(weapon.enhancement);
  const user = db.getOrCreateUser(userId);
  const inventory = db.getInventory(userId);
  
  const needsStone = weapon.enhancement === 9 || weapon.enhancement === 14;
  let stoneCount = 0;
  if (needsStone) {
    const stone = inventory.find(item => item.item_name === '조약돌');
    stoneCount = stone ? stone.quantity : 0;
    if (stoneCount < 1) {
      return message.reply(`조약돌이 필요합니다! (${weapon.enhancement + 1}강)\n보유 조약돌: ${stoneCount}개`);
    }
  }
  
  const currentDust = Math.max(0, user.dust || 0);
  if (currentDust < cost) {
    return message.reply(`닢이 부족합니다. 필요: ${cost}닢, 보유: ${currentDust}닢`);
  }
  
  db.subtractDust(userId, cost);
  const afterUser = db.getOrCreateUser(userId);
  const remainingDust = Math.max(0, afterUser.dust || 0);
  
  if (needsStone) db.removeItem(userId, '조약돌', 1);
  
  // 강화 확률 계산
  const chance = calculateEnhancementChance(weapon.enhancement);
  const rand = Math.random();
  
  // 파괴 확률 (매우 낮음, 강화 단계가 높을수록 증가)
  const destroyChance = weapon.enhancement >= 15 ? 0.05 : weapon.enhancement >= 10 ? 0.02 : 0.01;
  const destroyed = Math.random() < destroyChance;
  
  const embed = new EmbedBuilder()
    .setTitle('무기 강화 결과')
    .setTimestamp();
  
  let costInfo = `소모 닢: ${cost}닢\n남은 닢: ${remainingDust}닢`;
  if (needsStone) costInfo += `\n소모 조약돌: 1개\n남은 조약돌: ${stoneCount - 1}개`;
  
  if (destroyed) {
    db.enhanceWeapon(userId, false, true);
    embed.setDescription(`💥 무기가 파괴되었습니다!\n\n${costInfo}`)
      .setColor(0xFF0000);
  } else if (rand < chance) {
    const result = db.enhanceWeapon(userId, true, false);
    embed.setDescription(`✅ 강화 성공! +${result.newLevel}강\n\n${costInfo}`)
      .setColor(0x00FF00);
  } else {
    db.enhanceWeapon(userId, false, false);
    embed.setDescription(`❌ 강화 실패! 무기는 안전합니다.\n\n${costInfo}`)
      .setColor(0xFFFF00);
  }
  
  message.reply({ embeds: [embed] });
}

// 관리자 권한 체크
function isAdmin(message) {
  if (!message.member) return false;
  return message.member.permissions.has('Administrator') || message.member.permissions.has('ManageGuild');
}

// 재화/아이템 전송
async function handleSend(message, args) {
  if (args.length < 2) {
    return message.reply('사용법: `!보내기 @유저 [재화양 또는 아이템명]`\n예: `!보내기 @유저 100` 또는 `!보내기 @유저 조약돌`');
  }
  
  // 멘션된 유저 찾기
  const mention = args[0];
  let targetUser = null;
  
  if (mention.startsWith('<@') && mention.endsWith('>')) {
    const userId = mention.replace(/[<@!>]/g, '');
    targetUser = await message.client.users.fetch(userId).catch(() => null);
  } else {
    return message.reply('유저를 멘션해주세요. 예: `!보내기 @유저 100`');
  }
  
  if (!targetUser) {
    return message.reply('유저를 찾을 수 없습니다.');
  }
  
  if (targetUser.id === message.author.id) {
    return message.reply('자기 자신에게는 보낼 수 없습니다.');
  }
  
  const senderId = message.author.id;
  const receiverId = targetUser.id;
  const itemOrAmount = args.slice(1).join(' ');
  
  // 숫자인지 확인 (재화인지 아이템인지)
  const amount = parseInt(itemOrAmount);
  
  if (!isNaN(amount)) {
    // 재화 전송
    if (amount <= 0) {
      return message.reply('0보다 큰 값을 입력해주세요.');
    }
    
    const sender = db.getOrCreateUser(senderId);
    const senderDust = Math.max(0, sender.dust || 0);
    if (senderDust < amount) {
      return message.reply(`닢이 부족합니다. 보유: ${senderDust}닢, 필요: ${amount}닢`);
    }
    db.subtractDust(senderId, amount);
    db.addDust(receiverId, amount);
    const embed = new EmbedBuilder()
      .setTitle('전송 완료!')
      .setDescription(`${targetUser.username}에게 ${amount}닢을 전송했습니다.`)
      .setColor(0x00FF00)
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  } else {
    // 아이템 전송
    const itemName = itemOrAmount;
    const inventory = db.getInventory(senderId);
    const item = inventory.find(i => i.item_name === itemName);
    
    if (!item) {
      return message.reply(`보유하지 않은 아이템입니다: ${itemName}`);
    }
    
    // 아이템 제거 및 추가
    if (!db.removeItem(senderId, itemName, 1)) {
      return message.reply('아이템 전송에 실패했습니다.');
    }
    
    db.addItem(receiverId, itemName, item.item_type, 1);
    
    const embed = new EmbedBuilder()
      .setTitle('전송 완료!')
      .setDescription(`${targetUser.username}에게 **${itemName}**을(를) 전송했습니다.`)
      .setColor(0x00FF00)
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  }
}

// 관리자용 지급 기능
async function handleGive(message, args) {
  if (!isAdmin(message)) {
    return message.reply('이 명령어는 관리자만 사용할 수 있습니다.');
  }
  
  if (args.length < 2) {
    return message.reply('사용법: `!지급 @유저 [재화양 또는 아이템명]`\n예: `!지급 @유저 1000` 또는 `!지급 @유저 조약돌`');
  }
  
  // 멘션된 유저 찾기
  const mention = args[0];
  let targetUser = null;
  
  if (mention.startsWith('<@') && mention.endsWith('>')) {
    const userId = mention.replace(/[<@!>]/g, '');
    targetUser = await message.client.users.fetch(userId).catch(() => null);
  } else {
    return message.reply('유저를 멘션해주세요. 예: `!지급 @유저 1000`');
  }
  
  if (!targetUser) {
    return message.reply('유저를 찾을 수 없습니다.');
  }
  
  const receiverId = targetUser.id;
  // 멘션 부분을 제외한 나머지 인자들을 합침
  const itemOrAmount = args.filter(arg => !arg.startsWith('<@')).join(' ');
  
  // 숫자인지 확인 (재화인지 아이템인지)
  const amount = parseInt(itemOrAmount);
  
  if (!isNaN(amount)) {
    // 재화 지급
    if (amount <= 0) {
      return message.reply('0보다 큰 값을 입력해주세요.');
    }
    
    db.addDust(receiverId, amount);
    
    const embed = new EmbedBuilder()
      .setTitle('지급 완료!')
      .setDescription(`${targetUser.username}에게 ${amount}닢을 지급했습니다.`)
      .setColor(0x00FF00)
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  } else {
    // 아이템 지급
    const itemName = itemOrAmount;
    db.addItem(receiverId, itemName, 'item', 1);
    
    const embed = new EmbedBuilder()
      .setTitle('지급 완료!')
      .setDescription(`${targetUser.username}에게 **${itemName}**을(를) 지급했습니다.`)
      .setColor(0x00FF00)
      .setTimestamp();
    
    message.reply({ embeds: [embed] });
  }
}

// 배틀 처리
async function handleBattle(message, args) {
  const userId = message.author.id;
  // 자정 체력 회복 체크
  db.checkDailyHeal(userId);
  const attacker = db.getOrCreateCharacter(userId);
  const attackerUser = db.getOrCreateUser(userId);
  
  // 체력이 0이면 배틀 불가
  if (attacker.current_hp <= 0) {
    return message.reply('체력이 0입니다! 자정이 지나면 회복되거나 나무열매를 사용하세요.');
  }
  
  // 배틀 횟수 체크 (닉네임 지정이든 랜덤이든 하루 10회 한정)
  const battleCount = db.getBattleCount(userId);
  if (battleCount >= 10) {
    return message.reply('오늘의 배틀 횟수를 모두 사용했습니다! (하루 10회)');
  }
  
  let defenderId;
  let defenderName;
  
  if (args.length >= 1) {
    // 상대방 닉네임으로 찾기
    defenderName = args.join(' ');
    if (attacker.name === defenderName) {
      return message.reply('자기 자신과는 배틀할 수 없습니다.');
    }
    defenderId = db.findUserByName(defenderName);
    if (!defenderId) {
      return message.reply(`"${defenderName}"라는 이름의 캐릭터를 찾을 수 없습니다.`);
    }
    if (defenderId === userId) {
      return message.reply('자기 자신과는 배틀할 수 없습니다.');
    }
  } else {
    // 랜덤 상대 매칭
    defenderId = db.getRandomCharacterId(userId);
    if (!defenderId) {
      return message.reply('배틀할 상대가 없습니다. (다른 유저가 먼저 `!캐릭터`로 캐릭터를 생성해 주세요.)');
    }
    defenderName = db.getOrCreateCharacter(defenderId).name;
  }
  
  const defender = db.getOrCreateCharacter(defenderId);
  
  const attackerWeapon = db.getWeapon(userId);
  let attackerAttack = attacker.attack;
  let attackerDefense = attacker.defense;
  if (attackerWeapon) {
    const bonus = attackerWeapon.enhancement * 2;
    if (attackerWeapon.weapon_type === '가시') attackerAttack += bonus;
    else if (attackerWeapon.weapon_type === '껍질') attackerDefense += bonus;
  }
  
  const defenderWeapon = db.getWeapon(defenderId);
  let defenderAttack = defender.attack;
  let defenderDefense = defender.defense;
  if (defenderWeapon) {
    const bonus = defenderWeapon.enhancement * 2;
    if (defenderWeapon.weapon_type === '가시') defenderAttack += bonus;
    else if (defenderWeapon.weapon_type === '껍질') defenderDefense += bonus;
  }
  
  const attackerLevelBonus = attacker.level * 5;
  const defenderLevelBonus = defender.level * 5;
  const attackerPower = attackerAttack + attackerDefense + attackerLevelBonus;
  const defenderPower = defenderAttack + defenderDefense + defenderLevelBonus;
  
  // 승부 결정 (약간의 랜덤 요소 추가)
  const attackerRoll = attackerPower + Math.floor(Math.random() * 20);
  const defenderRoll = defenderPower + Math.floor(Math.random() * 20);
  
  db.incrementBattle(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('⚔️ 배틀 결과')
    .setTimestamp();
  
  const defenderInfo = `**${defender.name}** (Lv.${defender.level})\n공격력: ${defenderAttack} | 방어력: ${defenderDefense}`;
  
  if (attackerRoll > defenderRoll) {
    const reward = Math.floor(defenderPower / 10) + 50;
    db.addDust(userId, reward);
    db.addExp(userId, 1);
    const levelResult = db.addExp(userId, 0);
    let description = `**${attacker.name}**이(가) **${defender.name}**을(를) 이겼습니다! 🎉\n\n`;
    description += `📊 상대방 정보: ${defenderInfo}\n\n`;
    description += `💰 ${reward}닢을 획득했습니다!\n`;
    description += `✨ 경험치 +1\n`;
    
    if (levelResult.leveledUp) {
      description += `\n🎉 레벨업! 레벨 ${levelResult.oldLevel} → ${levelResult.newLevel}`;
      embed.setColor(0xFFD700);
    } else {
      embed.setColor(0x00FF00);
    }
    
    embed.setDescription(description);
  } else {
    // 방어자 승리 (공격자 패배) - 체력 감소
    const hpBefore = attacker.current_hp;
    const hpAfter = db.decreaseHp(userId, 5);
    
    let description = `**${attacker.name}**이(가) **${defender.name}**에게 패배했습니다... 😢\n\n`;
    description += `📊 상대방 정보: ${defenderInfo}\n\n`;
    description += `💔 체력이 5 감소했습니다! (${hpBefore} → ${hpAfter})\n`;
    
    if (hpAfter === 0) {
      description += `\n⚠️ 체력이 0이 되었습니다! 자정이 지나면 회복됩니다.`;
    }
    
    embed.setDescription(description)
      .setColor(0xFF0000);
  }
  
  message.reply({ embeds: [embed] });
}

// 상점 아이템 목록 (작은 생물 컨셉: 닢=나뭇잎 화폐)
const shopItems = {
  '가시': { type: 'weapon', price: 100, emoji: '🌵', description: '공격력을 올려주는 무기' },
  '껍질': { type: 'weapon', price: 100, emoji: '🛡️', description: '방어력을 올려주는 무기' },
  '조약돌': { type: 'item', price: 200, emoji: '💎', description: '무기 강화에 사용' },
  '나무열매': { type: 'item', price: 150, emoji: '🍒', description: '체력을 회복' },
  '랜덤박스': { type: 'item', price: 300, emoji: '📦', description: '랜덤 아이템' },
  '모험기록': { type: 'item', price: 250, emoji: '📜', description: '경험치 획득량 증가' }
};

// 되팔기/교환 가격 (상점 구매품 50%, 잡동사니는 고정 닢)
function getSellPrice(itemName) {
  const item = shopItems[itemName];
  if (item) return Math.floor(item.price * 0.5);
  const junk = junkItems.find(j => j.name === itemName);
  if (junk) return junk.price;
  return null;
}

// 상점 표시
async function handleShop(message) {
  const embed = new EmbedBuilder()
    .setTitle('🏪 닢 상점')
    .setColor(0xFFD700)
    .setTimestamp();
  let description = '**무기**\n';
  description += '🌵 **가시** - 100닢 (공격력)\n';
  description += '🛡️ **껍질** - 100닢 (방어력)\n\n';
  description += '**아이템**\n';
  description += '💎 **조약돌** - 200닢 (무기 강화용)\n';
  description += '🍒 **나무열매** - 150닢 (체력 회복)\n';
  description += '📦 **랜덤박스** - 300닢\n';
  description += '📜 **모험기록** - 250닢 (경험치 증가)\n\n';
  description += '구매: `!구매 [아이템명]`\n되팔기: `!판매 [아이템명] (수량)` (구입가 50%)';
  embed.setDescription(description);
  message.reply({ embeds: [embed] });
}

// 되팔기(판매) 처리
async function handleSell(message, args) {
  if (args.length < 1) {
    return message.reply('사용법: `!판매 [아이템명] (수량)`\n예: `!판매 나무열매` 또는 `!판매 조약돌 3`\n수량을 생략하면 1개 판매됩니다.');
  }
  
  const userId = message.author.id;
  const inventory = db.getInventory(userId);
  
  let itemName = args.join(' ').trim();
  itemName = itemName.replace(/^\[|\]$/g, '').trim();
  
  let quantity = 1;
  const lastArg = args[args.length - 1];
  const num = parseInt(lastArg, 10);
  if (!isNaN(num) && num >= 1 && String(num) === lastArg) {
    quantity = num;
    itemName = args.slice(0, -1).join(' ').trim();
    if (!itemName) {
      return message.reply('사용법: `!판매 [아이템명] (수량)`');
    }
  }
  
  let canonicalName = itemName;
  if (getSellPrice(itemName) === null) {
    const lower = itemName.toLowerCase();
    for (const key of Object.keys(shopItems)) {
      if (key.toLowerCase() === lower) { canonicalName = key; break; }
    }
    if (getSellPrice(canonicalName) === null) {
      for (const j of junkItems) {
        if (j.name.toLowerCase() === lower) { canonicalName = j.name; break; }
      }
    }
  }
  const sellPrice = getSellPrice(canonicalName);
  if (sellPrice === null) {
    const names = [...Object.keys(shopItems), ...junkItems.map(j => j.name)].join(', ');
    return message.reply(`되팔/교환할 수 없는 아이템입니다. 가능: ${names}`);
  }
  itemName = canonicalName;
  
  const invEntry = inventory.find(i => i.item_name === itemName);
  if (!invEntry || invEntry.quantity < quantity) {
    const have = invEntry ? invEntry.quantity : 0;
    return message.reply(`보유 수량이 부족합니다. **${itemName}** 보유: ${have}개, 요청: ${quantity}개`);
  }
  
  db.removeItem(userId, itemName, quantity);
  const totalEarned = sellPrice * quantity;
  db.addDust(userId, totalEarned);
  
  const afterUser = db.getOrCreateUser(userId);
  const displayDust = Math.max(0, afterUser.dust || 0);
  
  const item = shopItems[itemName];
  const junk = junkItems.find(j => j.name === itemName);
  const emoji = item ? item.emoji : (junk ? junk.emoji : '📦');
  const embed = new EmbedBuilder()
    .setTitle('되팔기 완료!')
    .setDescription(`${emoji} **${itemName}** ${quantity}개를 ${totalEarned}닢에 되팔았습니다.\n\n보유 닢: ${displayDust}닢`)
    .setColor(0x00FF00)
    .setTimestamp();
  message.reply({ embeds: [embed] });
}

// 랜덤박스 열기 (잡동사니 포함 풀)
const RANDOM_BOX_POOL = ['조약돌', '나무열매', '모험기록', '동전', '작은열매', '도토리', '들꽃', '나비날개', '깃털'];

async function handleOpenRandomBox(message) {
  const userId = message.author.id;
  const inventory = db.getInventory(userId);
  const toUse = inventory.find(i => i.item_name === '랜덤박스');
  if (!toUse || toUse.quantity < 1) {
    return message.reply('랜덤박스가 없습니다. 상점·탐험·땅굴에서 얻을 수 있습니다.');
  }
  db.removeItem(userId, toUse.item_name, 1);
  const itemName = RANDOM_BOX_POOL[Math.floor(Math.random() * RANDOM_BOX_POOL.length)];
  db.addItem(userId, itemName, 'item', 1);
  const junk = junkItems.find(j => j.name === itemName);
  const emoji = junk ? junk.emoji : (shopItems[itemName] ? shopItems[itemName].emoji : '📦');
  const embed = new EmbedBuilder()
    .setTitle('📦 랜덤박스 열기')
    .setDescription(`${emoji} **${itemName}**을(를) 얻었습니다!`)
    .setColor(0x9B59B6)
    .setTimestamp();
  message.reply({ embeds: [embed] });
}

// 아이템 사용 (!사용 [아이템이름]) - 경험치/능력치 등 확장 가능
const USABLE_ITEMS = {
  '모험기록': {
    dailyLimit: true,
    effect: (message, userId) => {
      if (!db.canUseItemToday(userId, '모험기록')) {
        return { ok: false, message: '모험기록은 하루에 1회만 사용할 수 있습니다.' };
      }
      const today = new Date().toISOString().split('T')[0];
      db.setLastItemUse(userId, '모험기록', today);
      db.removeItem(userId, '모험기록', 1);
      const levelResult = db.addExp(userId, 3);
      const char = db.getOrCreateCharacter(userId);
      let desc = `📜 **모험기록**을 읽었습니다!\n\n✨ 경험치 +3\n현재: ${char.exp}/${(char.level + 1) * 5} EXP`;
      if (levelResult.leveledUp) {
        desc += `\n\n🎉 **레벨 업!** Lv.${levelResult.oldLevel} → Lv.${levelResult.newLevel}`;
      }
      return { ok: true, description: desc, color: 0xF1C40F };
    }
  },
  '랜덤박스': {
    effect: (message, userId, opts = {}) => {
      const actualName = opts.actualItemName || '랜덤박스';
      db.removeItem(userId, actualName, 1);
      const itemName = RANDOM_BOX_POOL[Math.floor(Math.random() * RANDOM_BOX_POOL.length)];
      db.addItem(userId, itemName, 'item', 1);
      const junk = junkItems.find(j => j.name === itemName);
      const emoji = junk ? junk.emoji : (shopItems[itemName] ? shopItems[itemName].emoji : '📦');
      return { ok: true, description: `${emoji} **${itemName}**을(를) 얻었습니다!`, color: 0x9B59B6 };
    }
  }
};

async function handleUseItem(message, args) {
  try {
    const itemName = args.join(' ').trim();
    if (!itemName) {
      await message.reply('사용할 아이템 이름을 입력하세요. (예: `!사용 모험기록`)');
      return;
    }
    const userId = message.author.id;
    const inventory = db.getInventory(userId);
    const entry = inventory.find(i =>
      i.item_name === itemName ||
      (itemName === '랜덤박스' && i.item_name === '랜덤 박스') ||
      (itemName === '랜덤 박스' && i.item_name === '랜덤박스')
    );
    if (!entry || entry.quantity < 1) {
      await message.reply(`**${itemName}**을(를) 보유하고 있지 않습니다.`);
      return;
    }
    const handlerKey = (itemName === '랜덤 박스' ? '랜덤박스' : itemName);
    const handler = USABLE_ITEMS[handlerKey];
    if (!handler || !handler.effect) {
      await message.reply('사용할 수 없는 아이템입니다.');
      return;
    }
    const result = handler.effect(message, userId, { actualItemName: entry.item_name });
    if (!result || typeof result !== 'object') {
      await message.reply('아이템 사용 처리 중 오류가 발생했습니다.');
      return;
    }
    if (!result.ok) {
      await message.reply(result.message);
      return;
    }
    const embed = new EmbedBuilder()
      .setTitle('아이템 사용')
      .setDescription(result.description)
      .setColor(result.color ?? 0x3498DB)
      .setTimestamp();
    await message.reply({ embeds: [embed] });
  } catch (err) {
    console.error('[!사용] 오류:', err);
    await message.reply('아이템 사용 중 오류가 발생했습니다.').catch(() => {});
  }
}

// 상점 구매 처리
async function handleBuy(message, args) {
  if (args.length < 1) {
    return message.reply('사용법: `!구매 [아이템명]`\n`!상점`을 입력하면 판매 중인 아이템 목록을 볼 수 있습니다.');
  }
  
  const userId = message.author.id;
  // 대괄호 제거 및 공백 정리
  let itemName = args.join(' ').trim();
  itemName = itemName.replace(/^\[|\]$/g, '').trim(); // [검] -> 검
  
  // shopItems에서 찾기 (대소문자 구분 없이)
  let item = shopItems[itemName];
  
  // 찾지 못한 경우 부분 일치로 재시도
  if (!item) {
    const lowerItemName = itemName.toLowerCase();
    for (const [key, value] of Object.entries(shopItems)) {
      if (key.toLowerCase() === lowerItemName) {
        item = value;
        itemName = key; // 원본 키 사용
        break;
      }
    }
  }
  
  if (!item) {
    return message.reply(`"${itemName}"은(는) 판매하지 않는 아이템입니다.\n` + 
      '`!상점`을 입력하면 판매 중인 아이템 목록을 볼 수 있습니다.');
  }
  
  const user = db.getOrCreateUser(userId);
  const price = item.price;
  const currentDust = Math.max(0, user.dust || 0);
  
  if (currentDust < price) {
    return message.reply(`닢이 부족합니다. 필요: ${price}닢, 보유: ${currentDust}닢`);
  }
  db.subtractDust(userId, price);
  const afterUser = db.getOrCreateUser(userId);
  const displayDust = Math.max(0, afterUser.dust || 0);
  const embed = new EmbedBuilder()
    .setTitle('구매 완료!')
    .setColor(0x00FF00)
    .setTimestamp();
  if (item.type === 'weapon') {
    db.equipWeapon(userId, itemName);
    embed.setDescription(`${item.emoji} **${itemName}**을(를) 구매하고 장착했습니다!\n\n보유 닢: ${displayDust}닢`);
  } else {
    db.addItem(userId, itemName, 'item', 1);
    embed.setDescription(`${item.emoji} **${itemName}**을(를) 구매했습니다!\n\n보유 닢: ${displayDust}닢`);
  }
  message.reply({ embeds: [embed] });
}

// 도움말 처리
async function handleHelp(message) {
  const embed = new EmbedBuilder()
    .setTitle('📖 명령어 도움말')
    .setColor(0x3498DB)
    .setTimestamp()
    .addFields(
      {
        name: '🎮 기본 명령어',
        value: '`!출석` - 출석하고 닢을 획득\n`!탐험` - 탐험 (하루 3회)\n`!가방` - 가방 확인',
        inline: false
      },
      {
        name: '👤 캐릭터',
        value: '`!캐릭터` - 정보 확인\n`!캐릭터 수정 [이름]` - 이름 변경',
        inline: false
      },
      {
        name: '⚔️ 무기',
        value: '`!무기` - 장착 무기 확인\n`!무기장착 [가시/껍질]` - 무기 장착\n`!무기강화` - 강화 (최대 +20강)',
        inline: false
      },
      {
        name: '⚔️ 배틀',
        value: '`!배틀` - 랜덤 상대\n`!배틀 [상대 닉네임]` - 지정 상대 (하루 10회)\n승리 시 닢·경험치 획득!',
        inline: false
      },
      {
        name: '🏪 상점 / 아이템',
        value: '`!상점` - 상점\n`!구매 [아이템명]` - 구매\n`!판매 [아이템명] (수량)` - 되팔기/잡동사니 교환\n`!박스열기` / `!사용 랜덤박스` - 랜덤박스 열기\n`!사용 [아이템이름]` - 아이템 사용 (예: 모험기록, 랜덤박스)',
        inline: false
      },
      {
        name: '💊 회복',
        value: '`!회복` - 나무열매 사용 (체력 50 회복)',
        inline: false
      },
      {
        name: '🕳️ 땅굴',
        value: '`!땅굴` - 진입 또는 탐사 (체력 소모)\n`!땅굴 탈출` - 땅굴에서 나가기',
        inline: false
      },
      {
        name: '💸 거래',
        value: '`!보내기 @유저 [재화양 또는 아이템명]` - 다른 유저에게 재화나 아이템 전송',
        inline: false
      },
      {
        name: '👑 관리자 명령어',
        value: '`!지급 @유저 [재화양 또는 아이템명]` - 유저에게 재화나 아이템 지급',
        inline: false
      }
    )
    .setFooter({ text: '더 자세한 정보는 각 명령어를 입력해보세요!' });
  
  await message.reply({ embeds: [embed] });
}

// 나무열매 사용 (체력 회복)
async function handleHeal(message) {
  const userId = message.author.id;
  db.checkDailyHeal(userId);
  const character = db.getOrCreateCharacter(userId);
  const inventory = db.getInventory(userId);
  const potion = inventory.find(item => item.item_name === '나무열매');
  if (!potion || potion.quantity < 1) {
    return message.reply('나무열매가 없습니다. 상점에서 구매할 수 있습니다.');
  }
  if (character.current_hp >= character.max_hp) {
    return message.reply('이미 체력이 최대입니다!');
  }
  db.removeItem(userId, '나무열매', 1);
  const hpBefore = character.current_hp;
  const hpAfter = db.healHp(userId, 50);
  const embed = new EmbedBuilder()
    .setTitle('회복 완료!')
    .setDescription(`🍒 나무열매를 먹었습니다!\n\n체력: ${hpBefore} → ${hpAfter} / ${character.max_hp}`)
    .setColor(0x00FF00)
    .setTimestamp();
  message.reply({ embeds: [embed] });
}

// 땅굴 스레드 가져오기 또는 생성
async function getOrCreateDungeonThread(message, userId) {
  const existing = dungeonThreads.get(userId);
  if (existing) {
    try {
      const thread = await message.client.channels.fetch(existing.threadId);
      return thread;
    } catch (e) {
      dungeonThreads.delete(userId);
    }
  }
  const channel = message.channel;
  if (!channel.threads || typeof channel.threads.create !== 'function') {
    return null;
  }
  const character = db.getOrCreateCharacter(userId);
  const threadName = `🕳️ 땅굴 - ${character.name}`.slice(0, 100);
  const thread = await channel.threads.create({
    name: threadName,
    type: ChannelType.PublicThread,
    reason: '땅굴 탐사'
  }).catch(() => null);
  if (thread) {
    dungeonThreads.set(userId, { threadId: thread.id, channelId: channel.id });
  }
  return thread;
}

// 땅굴 진입
async function handleDungeon(message) {
  const userId = message.author.id;
  db.checkDailyHeal(userId);
  const character = db.getOrCreateCharacter(userId);
  
  if (character.current_hp <= 0) {
    return message.reply('체력이 0입니다! 회복 후 땅굴에 진입하세요.');
  }
  
  const result = db.enterDungeon(userId);
  if (!result.success) return message.reply(result.message);
  
  const embed = new EmbedBuilder()
    .setTitle('🕳️ 땅굴 진입!')
    .setDescription(`땅굴 ${result.floor}층에 들어왔습니다!\n\n` +
      `체력: ${character.current_hp}/${character.max_hp}\n\n` +
      `\`!땅굴\`로 탐사를 진행하세요.\n` +
      `\`!땅굴 탈출\`로 나갈 수 있습니다.`)
    .setColor(0x8B4513)
    .setTimestamp();
  
  const thread = await getOrCreateDungeonThread(message, userId);
  if (thread) {
    await thread.send({ embeds: [embed] });
    await message.reply('땅굴 스레드가 생성되었습니다. **스레드**에서 `!땅굴`로 탐사하세요.');
  } else {
    await message.reply({ embeds: [embed] });
  }
}

// 땅굴 탐사 (체력 소모, 땅 속 생물 조우)
const BURROW_HP_COST = 3; // 탐사 1회당 체력 3
const BURROW_MONSTERS = ['뱀', '두더쥐', '땅강아지', '거미', '지렁이'];

async function handleDungeonExplore(message) {
  const userId = message.author.id;
  if (!db.isInDungeon(userId)) {
    return message.reply('땅굴에 있지 않습니다. `!땅굴`로 진입하세요.');
  }
  
  const character = db.getOrCreateCharacter(userId);
  if (character.current_hp <= 0) {
    db.resetDungeon(userId);
    return message.reply('체력이 0이 되어 땅굴에서 나왔습니다. 1층부터 다시 시작하세요.');
  }
  
  const floor = db.getDungeonFloor(userId);
  const hpBefore = character.current_hp;
  const hpAfter = db.decreaseHp(userId, BURROW_HP_COST);
  if (hpAfter <= 0) {
    db.resetDungeon(userId);
    return message.reply(`탐사 중 체력이 0이 되었습니다. 땅굴에서 나왔습니다. (1층부터 다시)`);
  }
  
  const monsterChance = 0.3 + (floor * 0.05);
  const hasMonster = Math.random() < Math.min(monsterChance, 0.8);
  const monsterName = BURROW_MONSTERS[Math.floor(Math.random() * BURROW_MONSTERS.length)];
  
  const embed = new EmbedBuilder()
    .setTitle(`🕳️ 땅굴 ${floor}층 탐사`)
    .setTimestamp();
  
  if (hasMonster) {
    const character = db.getOrCreateCharacter(userId);
    const weapon = db.getWeapon(userId);
    let attack = character.attack;
    let defense = character.defense;
    if (weapon) {
      const bonus = weapon.enhancement * 2;
      if (weapon.weapon_type === '가시') attack += bonus;
      else if (weapon.weapon_type === '껍질') defense += bonus;
    }
    const playerPower = attack + defense + (character.level * 5);
    const monsterBasePower = 50 + (floor * 20);
    const monsterPower = monsterBasePower + Math.floor(Math.random() * 30);
    const playerRoll = playerPower + Math.floor(Math.random() * 20);
    const monsterRoll = monsterPower + Math.floor(Math.random() * 20);
    
    let battleComment = '';
    try {
      if (genAI) {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `작은 동물(쥐, 도마뱀)이 땅굴 ${floor}층에서 ${monsterName}와 맞서는 장면을 80자 이내로 귀엽고 재미있게 묘사해주세요. 한국어로.`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        if (response && response.text) {
          const text = response.text().trim();
          if (text) battleComment = text.length > 80 ? text.substring(0, 77) + '...' : text;
        }
        if (!battleComment) battleComment = `${floor}층에서 ${monsterName}와 맞섰습니다!`;
      } else {
        battleComment = `${floor}층에서 ${monsterName}와 맞섰습니다!`;
      }
    } catch (error) {
      const msg = (error && typeof error.message === 'string' ? error.message : '') || String(error);
      const full = msg + String(error);
      if (/429|quota|Too Many Requests/i.test(full)) console.warn('[Gemini] 할당량 초과 (땅굴).');
      else console.error('[땅굴 Gemini]', msg);
      battleComment = `${floor}층에서 ${monsterName}와 맞섰습니다!`;
    }
    
    // 공격력이 충분하면 몬스터를 처치 (요구 공격력: 20 + 층×4)
    const requiredAttackToKill = 20 + floor * 4;
    const killByAttack = attack >= requiredAttackToKill;

    if (killByAttack || playerRoll > monsterRoll) {
      const reward = Math.floor(monsterPower / 5) + (floor * 10);
      db.addDust(userId, reward);
      db.addExp(userId, 1);
      const newFloor = db.advanceDungeonFloor(userId);
      const winReason = killByAttack
        ? `✅ 공격력으로 ${monsterName}를(을) 처치했습니다!`
        : `✅ ${monsterName}를(을) 물리쳤습니다!`;
      embed.setDescription(`⚔️ ${battleComment}\n\n` +
        `${winReason}\n\n` +
        `💰 ${reward}닢 획득!\n✨ 경험치 +1\n📈 ${newFloor}층으로!\n\n` +
        `체력: ${db.getOrCreateCharacter(userId).current_hp}/${character.max_hp}`)
        .setColor(0x00FF00);
    } else {
      const dmg = 10;
      const hpAfterBattle = db.decreaseHp(userId, dmg);
      embed.setDescription(`⚔️ ${battleComment}\n\n` +
        `❌ ${monsterName}에게 당했습니다...\n\n` +
        `💔 체력 ${dmg} 감소! (${character.current_hp} → ${hpAfterBattle})\n\n` +
        `체력: ${hpAfterBattle}/${character.max_hp}`)
        .setColor(0xFF0000);
      if (hpAfterBattle <= 0) {
        db.resetDungeon(userId);
        embed.setDescription(embed.data.description + `\n\n⚠️ 체력 0! 땅굴에서 나왔습니다. 1층부터 다시.`);
      }
    }
  } else {
    const reward = 50 + (floor * 20) + Math.floor(Math.random() * 100);
    db.addDust(userId, reward);
    let itemReward = '';
    if (Math.random() < 0.2) {
      const items = ['조약돌', '나무열매', '랜덤박스'];
      const randomItem = items[Math.floor(Math.random() * items.length)];
      db.addItem(userId, randomItem, 'item', 1);
      itemReward = `\n📦 ${randomItem} 획득!`;
    }
    const dungeonJunk = rollJunkForDungeon();
    for (const j of dungeonJunk) {
      db.addItem(userId, j, 'item', 1);
      const jinfo = junkItems.find(x => x.name === j);
      itemReward += `\n${jinfo ? jinfo.emoji : '🪙'} ${j} 발견!`;
    }
    const newFloor = db.advanceDungeonFloor(userId);
    const charNow = db.getOrCreateCharacter(userId);
    embed.setDescription(`🔍 땅굴을 탐사했습니다...\n\n` +
      `💰 ${reward}닢 발견!${itemReward}\n📈 ${newFloor}층으로!\n\n` +
      `체력: ${charNow.current_hp}/${character.max_hp}`)
      .setColor(0x0099FF);
  }
  
  const thread = await getOrCreateDungeonThread(message, userId);
  if (thread) {
    await thread.send({ embeds: [embed] });
  } else {
    await message.reply({ embeds: [embed] });
  }
}

// 땅굴 탈출
async function handleDungeonExit(message) {
  const userId = message.author.id;
  if (!db.isInDungeon(userId)) {
    return message.reply('땅굴에 있지 않습니다.');
  }
  const floor = db.getDungeonFloor(userId);
  db.exitDungeon(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('🚪 땅굴 탈출!')
    .setDescription(`땅굴에서 나왔습니다.\n\n탐사한 최고 층: ${floor}층\n다시 \`!땅굴\`로 진입하면 ${floor}층부터 시작합니다.`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  const info = dungeonThreads.get(userId);
  dungeonThreads.delete(userId);
  if (info) {
    try {
      const thread = await message.client.channels.fetch(info.threadId);
      await thread.send({ embeds: [embed] });
    } catch (e) {
      await message.reply({ embeds: [embed] });
    }
  } else {
    await message.reply({ embeds: [embed] });
  }
}

client.login(config.token);

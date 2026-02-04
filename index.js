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

const { Client, GatewayIntentBits, EmbedBuilder } = require('discord.js');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const db = require('./database');

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

// 탐험 보상 계산
function calculateExplorationReward() {
  // 먼지 계산
  const dustRand = Math.random() * 100;
  let dust;
  
  // 낮은 확률로 5000먼지 (약 2%)
  if (dustRand < 2) {
    dust = 5000;
  } else {
    // 기본 100~1000 먼지
    dust = Math.floor(Math.random() * 901) + 100;
  }
  
  // 아이템 계산 (독립적인 확률, 약 5%)
  const itemRand = Math.random() * 100;
  let item = null;
  
  if (itemRand < 5) {
    const items = ['랜덤 박스', '강화석', '회복포션', '마나포션', '공략집'];
    item = items[Math.floor(Math.random() * items.length)];
  }
  
  return { dust, item };
}

// Gemini API로 탐험 코멘트 생성
async function generateExplorationComment() {
  if (!genAI) {
    // Gemini API 키가 없으면 기본 코멘트 반환
    const defaultComments = [
      '신비로운 동굴을 탐험했습니다.',
      '오래된 유적지를 발견했습니다.',
      '숨겨진 보물을 찾았습니다.',
      '위험한 던전을 탐험했습니다.',
      '고대의 비밀을 밝혀냈습니다.'
    ];
    return defaultComments[Math.floor(Math.random() * defaultComments.length)];
  }
  
  try {
    const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
    const prompt = '판타지 RPG 게임의 탐험 결과를 80자 이내로 간단하고 재미있게 묘사해주세요. 한국어로 작성해주세요.';
    
    const result = await model.generateContent(prompt);
    const response = await result.response;
    let text = response.text().trim();
    
    // 80자 제한
    if (text.length > 80) {
      text = text.substring(0, 77) + '...';
    }
    
    return text;
  } catch (error) {
    console.error('Gemini API 오류:', error.message || error);
    // 오류 발생 시 기본 코멘트 반환
    const defaultComments = [
      '신비로운 동굴을 탐험했습니다.',
      '오래된 유적지를 발견했습니다.',
      '숨겨진 보물을 찾았습니다.',
      '위험한 던전을 탐험했습니다.',
      '고대의 비밀을 밝혀냈습니다.',
      '마법의 숲을 지나갔습니다.',
      '용의 둥지를 발견했습니다.',
      '고대 신전의 문을 열었습니다.',
      '보물 상자를 발견했습니다.',
      '몬스터와 조우했습니다.'
    ];
    return defaultComments[Math.floor(Math.random() * defaultComments.length)];
  }
}

// 무기 강화 확률 계산
function calculateEnhancementChance(currentLevel) {
  if (currentLevel < 5) return 0.9;      // 90%
  if (currentLevel < 10) return 0.7;     // 70%
  if (currentLevel < 15) return 0.5;     // 50%
  if (currentLevel < 20) return 0.3;     // 30%
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
  if (!message.content.startsWith('!')) return;

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

  const command = message.content.split(' ')[0].toLowerCase();
  const args = message.content.slice(command.length).trim().split(' ');

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
      case '!스킬':
        await handleSkill(message);
        break;
      case '!스킬선택':
        await handleSkillSelect(message, args);
        break;
      case '!스킬이름':
        await handleSkillName(message, args);
        break;
      case '!스킬강화':
        await handleEnhanceSkill(message, args);
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
      case '!도움말':
        await handleHelp(message);
        break;
      case '!회복':
        await handleHeal(message);
        break;
      case '!마나회복':
        await handleManaHeal(message);
        break;
      case '!던전':
        if (db.isInDungeon(message.author.id)) {
          await handleDungeonExplore(message);
        } else {
          await handleDungeon(message);
        }
        break;
      case '!던전탈출':
        await handleDungeonExit(message);
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

// 출석 처리
async function handleAttendance(message) {
  const userId = message.author.id;
  const today = new Date().toISOString().split('T')[0];
  const user = db.getOrCreateUser(userId);
  
  if (user.last_attendance_date === today) {
    return message.reply('오늘은 이미 출석했습니다!');
  }
  
  const character = db.getOrCreateCharacter(userId);
  const reward = calculateAttendanceReward();
  db.addDust(userId, reward);
  db.setAttendance(userId, today);
  
  const updatedUser = db.getOrCreateUser(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('출석 완료!')
    .setDescription(`${character.name}이(가) 먼지 길드에 모습을 보였습니다.\n\n${reward}먼지를 획득했습니다!\n\n보유 먼지: ${updatedUser.dust}먼지`)
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
  
  // 아이템은 확률적으로 획득
  if (reward.item) {
    db.addItem(userId, reward.item, 'item');
  }
  
  // 경험치 추가
  const levelResult = db.addExp(userId, 1);
  
  // 탐험 코멘트 생성
  const explorationComment = await generateExplorationComment();
  
  const updatedUser = db.getOrCreateUser(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('탐험 완료!')
    .setColor(0x0099FF)
    .setTimestamp();
  
  let description = `📖 ${explorationComment}\n\n`;
  description += `💰 ${reward.dust}먼지를 획득했습니다!\n`;
  if (reward.item) {
    description += `📦 ${reward.item}을(를) 획득했습니다!\n`;
  }
  description += `✨ 경험치 +1\n`;
  description += `\n보유 먼지: ${updatedUser.dust}먼지\n`;
  
  if (levelResult.leveledUp) {
    description += `\n🎉 레벨업! 레벨 ${levelResult.oldLevel} → ${levelResult.newLevel}`;
    embed.setColor(0xFFD700);
  }
  
  embed.setDescription(description);
  message.reply({ embeds: [embed] });
}

// 가방 처리 (DM으로 전송)
async function handleInventory(message) {
  const userId = message.author.id;
  const inventory = db.getInventory(userId);
  const user = db.getOrCreateUser(userId);
  const weapon = db.getWeapon(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('📦 가방')
    .setColor(0x9B59B6)
    .setTimestamp();
  
  let description = `보유 먼지: ${user.dust}먼지\n\n`;
  
  // 장착한 무기 정보 표시
  if (weapon) {
    const weaponNames = {
      '검': '⚔️ 검',
      '방패': '🛡️ 방패',
      '지팡이': '🔮 지팡이'
    };
    description += `**장착 무기**\n${weaponNames[weapon.weapon_type] || weapon.weapon_type} (+${weapon.enhancement}강)\n\n`;
  }
  
  // 보유 무기 (인벤토리에서)
  const weapons = inventory.filter(item => ['검', '방패', '지팡이'].includes(item.item_name));
  if (weapons.length > 0) {
    description += '**보유 무기**\n';
    weapons.forEach(item => {
      const weaponEmojis = {
        '검': '⚔️',
        '방패': '🛡️',
        '지팡이': '🔮'
      };
      description += `${weaponEmojis[item.item_name] || ''} **${item.item_name}** x${item.quantity}\n`;
    });
    description += '\n';
  }
  
  // 스킬북 (인벤토리에서)
  const skillbooks = inventory.filter(item => item.item_name === '스킬북');
  if (skillbooks.length > 0) {
    description += '**스킬북**\n';
    skillbooks.forEach(item => {
      description += `📚 **${item.item_name}** x${item.quantity}\n`;
    });
    description += '\n';
  }
  
  // 아이템 목록 (무기와 스킬북 제외)
  const regularItems = inventory.filter(item => 
    !['검', '방패', '지팡이', '스킬북'].includes(item.item_name)
  );
  
  description += '**보유 아이템**\n';
  if (regularItems.length === 0 && weapons.length === 0 && skillbooks.length === 0) {
    description += '아이템이 없습니다.';
  } else if (regularItems.length === 0) {
    description += '일반 아이템이 없습니다.';
  } else {
    regularItems.forEach(item => {
      description += `**${item.item_name}** x${item.quantity}\n`;
    });
  }
  
  embed.setDescription(description);
  
  try {
    await message.author.send({ embeds: [embed] });
    message.reply('가방 내용을 DM으로 전송했습니다.');
  } catch (error) {
    message.reply('DM을 보낼 수 없습니다. DM 설정을 확인해주세요.');
  }
}

// 캐릭터 정보 표시
async function handleCharacter(message) {
  const userId = message.author.id;
  const character = db.getOrCreateCharacter(userId);
  const user = db.getOrCreateUser(userId);
  const weapon = db.getWeapon(userId);
  
  // 무기 보너스 계산
  let attackBonus = 0;
  let defenseBonus = 0;
  let magicBonus = 0;
  
  if (weapon) {
    const bonus = weapon.enhancement * 2; // 강화당 +2
    if (weapon.weapon_type === '검') attackBonus = bonus;
    else if (weapon.weapon_type === '방패') defenseBonus = bonus;
    else if (weapon.weapon_type === '지팡이') magicBonus = bonus;
  }
  
  const embed = new EmbedBuilder()
    .setTitle(`👤 ${character.name}`)
    .addFields(
      { name: '레벨', value: `${character.level}`, inline: true },
      { name: '경험치', value: `${character.exp}/${(character.level + 1) * 5}`, inline: true },
      { name: '먼지', value: `${user.dust}`, inline: true },
      { name: '체력', value: `${character.current_hp}/${character.max_hp}`, inline: true },
      { name: '공격력', value: `${character.attack + attackBonus}${attackBonus > 0 ? ` (+${attackBonus})` : ''}`, inline: true },
      { name: '방어력', value: `${character.defense + defenseBonus}${defenseBonus > 0 ? ` (+${defenseBonus})` : ''}`, inline: true },
      { name: '마력', value: `${character.magic + magicBonus}${magicBonus > 0 ? ` (+${magicBonus})` : ''}`, inline: true }
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
    return message.reply('장착한 무기가 없습니다. `!무기장착 [검/방패/지팡이]` 명령어로 무기를 장착하세요.');
  }
  
  const weaponNames = {
    '검': '⚔️ 검',
    '방패': '🛡️ 방패',
    '지팡이': '🔮 지팡이'
  };
  
  const statNames = {
    '검': '공격력',
    '방패': '방어력',
    '지팡이': '마력'
  };
  
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
    return message.reply('사용법: `!무기장착 [검/방패/지팡이]`');
  }
  
  const weaponType = args[0];
  const validTypes = ['검', '방패', '지팡이'];
  
  if (!validTypes.includes(weaponType)) {
    return message.reply('올바른 무기 종류를 입력하세요: 검, 방패, 지팡이');
  }
  
  db.equipWeapon(userId, weaponType);
  
  const weaponNames = {
    '검': '⚔️ 검',
    '방패': '🛡️ 방패',
    '지팡이': '🔮 지팡이'
  };
  
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
  
  // 10강 또는 15강으로 갈 때 강화석 필요
  const needsEnhancementStone = weapon.enhancement === 9 || weapon.enhancement === 14;
  let enhancementStoneCount = 0;
  
  if (needsEnhancementStone) {
    const enhancementStone = inventory.find(item => item.item_name === '강화석');
    enhancementStoneCount = enhancementStone ? enhancementStone.quantity : 0;
    
    if (enhancementStoneCount < 1) {
      return message.reply(`강화석이 필요합니다! (${weapon.enhancement + 1}강으로 가기 위해 필요)\n보유 강화석: ${enhancementStoneCount}개`);
    }
  }
  
  if (user.dust < cost) {
    return message.reply(`먼지가 부족합니다. 필요: ${cost}먼지, 보유: ${user.dust}먼지`);
  }
  
  // 비용 차감
  db.subtractDust(userId, cost);
  const remainingDust = user.dust - cost;
  
  // 강화석 사용
  if (needsEnhancementStone) {
    db.removeItem(userId, '강화석', 1);
  }
  
  // 강화 확률 계산
  const chance = calculateEnhancementChance(weapon.enhancement);
  const rand = Math.random();
  
  // 파괴 확률 (매우 낮음, 강화 단계가 높을수록 증가)
  const destroyChance = weapon.enhancement >= 15 ? 0.05 : weapon.enhancement >= 10 ? 0.02 : 0.01;
  const destroyed = Math.random() < destroyChance;
  
  const embed = new EmbedBuilder()
    .setTitle('무기 강화 결과')
    .setTimestamp();
  
  // 소모 재화 정보
  let costInfo = `소모 먼지: ${cost}먼지\n남은 먼지: ${remainingDust}먼지`;
  if (needsEnhancementStone) {
    costInfo += `\n소모 강화석: 1개\n남은 강화석: ${enhancementStoneCount - 1}개`;
  }
  
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

// 스킬 정보 표시
async function handleSkill(message) {
  const userId = message.author.id;
  const skill = db.getOrCreateSkill(userId);
  
  if (!skill.skill_name || !skill.skill_type) {
    return message.reply('스킬이 없습니다. 상점에서 스킬북을 구매하여 스킬을 획득하세요.');
  }
  
  const skillTypeEmojis = {
    '불': '🔥',
    '물': '💧',
    '풀': '🌿',
    '땅': '🌍',
    '바람': '💨'
  };
  
  const embed = new EmbedBuilder()
    .setTitle('스킬 정보')
    .addFields(
      { name: '스킬명', value: skill.skill_name, inline: true },
      { name: '타입', value: `${skillTypeEmojis[skill.skill_type] || ''} ${skill.skill_type}`, inline: true },
      { name: '레벨', value: `${skill.skill_level}`, inline: true }
    )
    .setColor(0x9B59B6)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 스킬 타입 선택
async function handleSkillSelect(message, args) {
  const userId = message.author.id;
  const inventory = db.getInventory(userId);
  
  // 스킬북 확인
  const skillbook = inventory.find(item => item.item_name === '스킬북');
  if (!skillbook || skillbook.quantity < 1) {
    return message.reply('스킬북이 없습니다. 상점에서 스킬북을 구매하세요.');
  }
  
  if (args.length < 1) {
    return message.reply('사용법: `!스킬선택 [불/물/풀/땅/바람]`\n예: `!스킬선택 불`');
  }
  
  const skillType = args[0];
  const validTypes = ['불', '물', '풀', '땅', '바람'];
  
  if (!validTypes.includes(skillType)) {
    return message.reply('올바른 스킬 타입을 입력하세요: 불, 물, 풀, 땅, 바람');
  }
  
  // 이미 스킬이 있으면 변경 불가
  const currentSkill = db.getOrCreateSkill(userId);
  if (currentSkill.skill_type) {
    return message.reply('이미 스킬을 보유하고 있습니다. 스킬을 변경하려면 기존 스킬을 삭제해야 합니다.');
  }
  
  // 스킬북 사용
  db.removeItem(userId, '스킬북', 1);
  
  // 스킬 타입 설정 (이름은 나중에 설정)
  db.setSkill(userId, skillType, null);
  
  const skillTypeEmojis = {
    '불': '🔥',
    '물': '💧',
    '풀': '🌿',
    '땅': '🌍',
    '바람': '💨'
  };
  
  const embed = new EmbedBuilder()
    .setTitle('스킬 타입 선택 완료!')
    .setDescription(`${skillTypeEmojis[skillType]} **${skillType}** 타입 스킬을 획득했습니다!\n\n` +
      `이제 스킬 이름을 설정하세요: \`!스킬이름 [스킬 이름]\`\n` +
      `예: \`!스킬이름 파이어볼\``)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 스킬 이름 설정
async function handleSkillName(message, args) {
  const userId = message.author.id;
  const skill = db.getOrCreateSkill(userId);
  
  if (!skill.skill_type) {
    return message.reply('먼저 스킬 타입을 선택하세요. 상점에서 스킬북을 구매하고 `!스킬선택 [타입]`을 사용하세요.');
  }
  
  if (args.length < 1) {
    return message.reply('사용법: `!스킬이름 [스킬 이름]`\n예: `!스킬이름 파이어볼`');
  }
  
  const skillName = args.join(' ');
  
  if (skillName.length > 20) {
    return message.reply('스킬 이름은 20자 이내로 입력해주세요.');
  }
  
  // 스킬 이름 설정
  db.setSkill(userId, skill.skill_type, skillName);
  
  const skillTypeEmojis = {
    '불': '🔥',
    '물': '💧',
    '풀': '🌿',
    '땅': '🌍',
    '바람': '💨'
  };
  
  const embed = new EmbedBuilder()
    .setTitle('스킬 이름 설정 완료!')
    .setDescription(`${skillTypeEmojis[skill.skill_type] || ''} **${skillName}** (${skill.skill_type} 타입) 스킬이 생성되었습니다!`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 스킬 강화
async function handleEnhanceSkill(message, args) {
  const userId = message.author.id;
  const skill = db.getOrCreateSkill(userId);
  const inventory = db.getInventory(userId);
  
  // 강화석 아이템 확인
  const enhancementStone = inventory.find(item => item.item_name === '강화석');
  
  if (!enhancementStone || enhancementStone.quantity < 1) {
    return message.reply('스킬 강화에 필요한 강화석이 없습니다. 탐험을 통해 획득할 수 있습니다.');
  }
  
  // 강화석 사용
  if (!db.removeItem(userId, '강화석', 1)) {
    return message.reply('강화석을 사용할 수 없습니다.');
  }
  
  // 강화 확률 (무기보다 높음, 70~90%)
  const baseChance = 0.8;
  const chance = baseChance - (skill.skill_level * 0.02); // 레벨이 높을수록 낮아짐
  const success = Math.random() < Math.max(chance, 0.5); // 최소 50%
  
  const embed = new EmbedBuilder()
    .setTitle('스킬 강화 결과')
    .setTimestamp();
  
  if (success) {
    db.enhanceSkill(userId, true);
    const newSkill = db.getOrCreateSkill(userId);
    embed.setDescription(`✅ 강화 성공! 스킬 레벨 ${skill.skill_level} → ${newSkill.skill_level}`)
      .setColor(0x00FF00);
  } else {
    embed.setDescription('❌ 강화 실패! 강화석은 소모되었지만 스킬은 안전합니다.')
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
    return message.reply('사용법: `!보내기 @유저 [재화양 또는 아이템명]`\n예: `!보내기 @유저 100` 또는 `!보내기 @유저 강화석`');
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
    if (sender.dust < amount) {
      return message.reply(`먼지가 부족합니다. 보유: ${sender.dust}먼지, 필요: ${amount}먼지`);
    }
    
    db.subtractDust(senderId, amount);
    db.addDust(receiverId, amount);
    
    const embed = new EmbedBuilder()
      .setTitle('전송 완료!')
      .setDescription(`${targetUser.username}에게 ${amount}먼지를 전송했습니다.`)
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
    return message.reply('사용법: `!지급 @유저 [재화양 또는 아이템명]`\n예: `!지급 @유저 1000` 또는 `!지급 @유저 강화석`');
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
      .setDescription(`${targetUser.username}에게 ${amount}먼지를 지급했습니다.`)
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
    return message.reply('체력이 0입니다! 자정이 지나면 회복되거나 회복포션을 사용하세요.');
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
  
  // 무기 보너스 계산
  const attackerWeapon = db.getWeapon(userId);
  let attackerAttack = attacker.attack;
  let attackerDefense = attacker.defense;
  let attackerMagic = attacker.magic;
  
  if (attackerWeapon) {
    const bonus = attackerWeapon.enhancement * 2;
    if (attackerWeapon.weapon_type === '검') attackerAttack += bonus;
    else if (attackerWeapon.weapon_type === '방패') attackerDefense += bonus;
    else if (attackerWeapon.weapon_type === '지팡이') attackerMagic += bonus;
  }
  
  const defenderWeapon = db.getWeapon(defenderId);
  let defenderAttack = defender.attack;
  let defenderDefense = defender.defense;
  let defenderMagic = defender.magic;
  
  if (defenderWeapon) {
    const bonus = defenderWeapon.enhancement * 2;
    if (defenderWeapon.weapon_type === '검') defenderAttack += bonus;
    else if (defenderWeapon.weapon_type === '방패') defenderDefense += bonus;
    else if (defenderWeapon.weapon_type === '지팡이') defenderMagic += bonus;
  }
  
  // 전투력 계산 (공격력 + 방어력 + 마력 + 레벨 보너스)
  // 레벨 보너스: 레벨당 +5 전투력
  const attackerLevelBonus = attacker.level * 5;
  const defenderLevelBonus = defender.level * 5;
  
  const attackerPower = attackerAttack + attackerDefense + attackerMagic + attackerLevelBonus;
  const defenderPower = defenderAttack + defenderDefense + defenderMagic + defenderLevelBonus;
  
  // 승부 결정 (약간의 랜덤 요소 추가)
  const attackerRoll = attackerPower + Math.floor(Math.random() * 20);
  const defenderRoll = defenderPower + Math.floor(Math.random() * 20);
  
  db.incrementBattle(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('⚔️ 배틀 결과')
    .setTimestamp();
  
  // 상대방 정보 표시
  const defenderInfo = `**${defender.name}** (Lv.${defender.level})\n공격력: ${defenderAttack} | 방어력: ${defenderDefense} | 마력: ${defenderMagic}`;
  
  if (attackerRoll > defenderRoll) {
    // 공격자 승리
    const reward = Math.floor(defenderPower / 10) + 50; // 상대 전투력의 10% + 기본 50
    db.addDust(userId, reward);
    db.addExp(userId, 1);
    
    const levelResult = db.addExp(userId, 0); // 레벨업 체크만
    
    let description = `**${attacker.name}**이(가) **${defender.name}**을(를) 이겼습니다! 🎉\n\n`;
    description += `📊 상대방 정보: ${defenderInfo}\n\n`;
    description += `💰 ${reward}먼지를 획득했습니다!\n`;
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

// 상점 아이템 목록
const shopItems = {
  // 무기
  '검': { type: 'weapon', price: 100, emoji: '⚔️', description: '공격력을 올려주는 무기' },
  '방패': { type: 'weapon', price: 100, emoji: '🛡️', description: '방어력을 올려주는 무기' },
  '지팡이': { type: 'weapon', price: 100, emoji: '🔮', description: '마력을 올려주는 무기' },
  // 아이템
  '강화석': { type: 'item', price: 200, emoji: '💎', description: '스킬 강화에 사용되는 아이템' },
  '회복포션': { type: 'item', price: 150, emoji: '🧪', description: '체력을 회복하는 포션' },
  '마나포션': { type: 'item', price: 150, emoji: '🔵', description: '마나를 회복하는 포션 (던전 내 사용)' },
  '랜덤 박스': { type: 'item', price: 300, emoji: '📦', description: '랜덤한 아이템을 얻을 수 있는 박스' },
  '공략집': { type: 'item', price: 250, emoji: '⚡', description: '경험치 획득량을 증가시키는 아이템' },
  '스킬북': { type: 'skillbook', price: 500, emoji: '📚', description: '스킬을 획득할 수 있는 책' }
};

// 상점 표시
async function handleShop(message) {
  const embed = new EmbedBuilder()
    .setTitle('🏪 먼지 상점')
    .setColor(0xFFD700)
    .setTimestamp();
  
  let description = '**무기**\n';
  description += '⚔️ **검** - 100먼지 (공격력 증가)\n';
  description += '🛡️ **방패** - 100먼지 (방어력 증가)\n';
  description += '🔮 **지팡이** - 100먼지 (마력 증가)\n\n';
  
  description += '**아이템**\n';
  description += '💎 **강화석** - 200먼지 (스킬 강화용)\n';
  description += '🧪 **회복포션** - 150먼지 (체력 회복)\n';
  description += '🔵 **마나포션** - 150먼지 (마나 회복, 던전 내 사용)\n';
  description += '📦 **랜덤 박스** - 300먼지 (랜덤 아이템)\n';
  description += '⚡ **공략집** - 250먼지 (경험치 증가)\n';
  description += '📚 **스킬북** - 500먼지 (스킬 획득)\n\n';
  
  description += '구매하려면 `!구매 [아이템명]`을 입력하세요.';
  
  embed.setDescription(description);
  message.reply({ embeds: [embed] });
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
  
  if (user.dust < price) {
    return message.reply(`먼지가 부족합니다. 필요: ${price}먼지, 보유: ${user.dust}먼지`);
  }
  
  db.subtractDust(userId, price);
  
  const embed = new EmbedBuilder()
    .setTitle('구매 완료!')
    .setColor(0x00FF00)
    .setTimestamp();
  
  if (item.type === 'weapon') {
    // 무기 구매 시 자동 장착
    db.equipWeapon(userId, itemName);
    embed.setDescription(`${item.emoji} **${itemName}**을(를) 구매하고 장착했습니다!\n\n보유 먼지: ${user.dust - price}먼지`);
    message.reply({ embeds: [embed] });
  } else if (item.type === 'skillbook') {
    // 스킬북 구매 시 인벤토리에 추가
    db.addItem(userId, itemName, 'item', 1);
    embed.setDescription(`${item.emoji} **${itemName}**을(를) 구매했습니다!\n\n` +
      `스킬 타입을 선택하세요: \`!스킬선택 [불/물/풀/땅/바람]\`\n` +
      `예: \`!스킬선택 불\`\n\n보유 먼지: ${user.dust - price}먼지`);
    message.reply({ embeds: [embed] });
  } else {
    // 아이템 구매 시 인벤토리에 추가
    db.addItem(userId, itemName, 'item', 1);
    embed.setDescription(`${item.emoji} **${itemName}**을(를) 구매했습니다!\n\n보유 먼지: ${user.dust - price}먼지`);
    message.reply({ embeds: [embed] });
  }
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
        value: '`!출석` - 출석하고 먼지를 획득합니다\n`!탐험` - 탐험을 진행합니다 (하루 3회)\n`!가방` - 가방 내용을 확인합니다',
        inline: false
      },
      {
        name: '👤 캐릭터 관련',
        value: '`!캐릭터` - 캐릭터 정보 확인\n`!캐릭터 수정 [이름]` - 캐릭터 이름 변경',
        inline: false
      },
      {
        name: '⚔️ 무기 시스템',
        value: '`!무기` - 현재 장착한 무기 확인\n`!무기장착 [검/방패/지팡이]` - 무기 장착\n`!무기강화` - 무기 강화 (최대 +20강)',
        inline: false
      },
      {
        name: '✨ 스킬 시스템',
        value: '`!스킬` - 스킬 정보 확인\n`!스킬강화` - 스킬 강화 (강화석 필요)',
        inline: false
      },
      {
        name: '⚔️ 배틀 시스템',
        value: '`!배틀` - 랜덤 상대와 배틀\n`!배틀 [상대방 닉네임]` - 지정 유저와 배틀 (하루 10회 공통)\n승리 시 먼지와 경험치 획득!',
        inline: false
      },
      {
        name: '🏪 상점',
        value: '`!상점` - 상점 확인\n`!구매 [아이템명]` - 아이템 구매',
        inline: false
      },
      {
        name: '💊 회복',
        value: '`!회복` - 회복포션 사용 (체력 50 회복)\n`!마나회복` - 마나포션 사용 (마나 30 회복, 던전 내에서만)',
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
  
  try {
    await message.author.send({ embeds: [embed] });
    // DM 전송 성공 시 채널에 간단한 확인 메시지만
    await message.react('✅').catch(() => {});
  } catch (error) {
    // DM 전송 실패 시 채널에 직접 표시
    await message.reply({ embeds: [embed] });
  }
}

// 회복포션 사용
async function handleHeal(message) {
  const userId = message.author.id;
  // 자정 체력 회복 체크
  db.checkDailyHeal(userId);
  const character = db.getOrCreateCharacter(userId);
  const inventory = db.getInventory(userId);
  
  // 회복포션 확인
  const potion = inventory.find(item => item.item_name === '회복포션');
  
  if (!potion || potion.quantity < 1) {
    return message.reply('회복포션이 없습니다. 상점에서 구매할 수 있습니다.');
  }
  
  // 체력이 이미 최대인지 확인
  if (character.current_hp >= character.max_hp) {
    return message.reply('이미 체력이 최대입니다!');
  }
  
  // 회복포션 사용
  db.removeItem(userId, '회복포션', 1);
  const hpBefore = character.current_hp;
  const hpAfter = db.healHp(userId, 50); // 50 회복
  
  const embed = new EmbedBuilder()
    .setTitle('회복 완료!')
    .setDescription(`🧪 회복포션을 사용했습니다!\n\n체력: ${hpBefore} → ${hpAfter} / ${character.max_hp}`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 마나포션 사용 (던전 내에서만)
async function handleManaHeal(message) {
  const userId = message.author.id;
  const character = db.getOrCreateCharacter(userId);
  const inventory = db.getInventory(userId);
  const maxMana = character.max_mana || 50;

  const potion = inventory.find(item => item.item_name === '마나포션');
  if (!potion || potion.quantity < 1) {
    return message.reply('마나포션이 없습니다. 상점에서 구매할 수 있습니다.');
  }

  if (!db.isInDungeon(userId)) {
    return message.reply('마나포션은 던전 안에서만 사용할 수 있습니다.');
  }

  if ((character.mana || 0) >= maxMana) {
    return message.reply('이미 마나가 최대입니다!');
  }

  db.removeItem(userId, '마나포션', 1);
  const manaBefore = db.getDungeonMana(userId);
  const manaAfter = db.healMana(userId, 30);

  const embed = new EmbedBuilder()
    .setTitle('마나 회복!')
    .setDescription(`🔵 마나포션을 사용했습니다!\n\n마나: ${manaBefore} → ${manaAfter} / ${maxMana}`)
    .setColor(0x0099FF)
    .setTimestamp();

  message.reply({ embeds: [embed] });
}

// 던전 진입
async function handleDungeon(message) {
  const userId = message.author.id;
  db.checkDailyHeal(userId);
  const character = db.getOrCreateCharacter(userId);
  
  // 체력 체크
  if (character.current_hp <= 0) {
    return message.reply('체력이 0입니다! 회복 후 던전에 진입하세요.');
  }
  
  const result = db.enterDungeon(userId);
  
  if (!result.success) {
    return message.reply(result.message);
  }
  
  const embed = new EmbedBuilder()
    .setTitle('🏰 던전 진입!')
    .setDescription(`던전 ${result.floor}층에 진입했습니다!\n\n` +
      `체력: ${character.current_hp}/${character.max_hp}\n` +
      `마나: ${result.mana}/${character.max_mana || 50}\n\n` +
      `\`!던전\`을 입력하여 탐사를 진행하세요.\n` +
      `\`!던전탈출\`을 입력하여 던전에서 나갈 수 있습니다.`)
    .setColor(0x8B4513)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

// 던전 탐사
async function handleDungeonExplore(message) {
  const userId = message.author.id;
  
  if (!db.isInDungeon(userId)) {
    return message.reply('던전에 있지 않습니다. `!던전`을 입력하여 던전에 진입하세요.');
  }
  
  const character = db.getOrCreateCharacter(userId);
  
  // 체력 체크
  if (character.current_hp <= 0) {
    db.resetDungeon(userId);
    return message.reply('체력이 0이 되어 던전에서 강제로 나왔습니다. 1층부터 다시 시작해야 합니다.');
  }
  
  // 마나 체크
  const currentMana = db.getDungeonMana(userId);
  if (currentMana < 5) {
    return message.reply(`마나가 부족합니다! (보유: ${currentMana}/필요: 5)\n던전을 탈출하거나 회복 후 다시 시도하세요.`);
  }
  
  const floor = db.getDungeonFloor(userId);
  
  // 마나 소모
  db.useDungeonMana(userId, 5);
  
  // 몬스터 만날 확률 (층이 높을수록 증가)
  const monsterChance = 0.3 + (floor * 0.05); // 30% + 층당 5%
  const hasMonster = Math.random() < Math.min(monsterChance, 0.8); // 최대 80%
  
  const embed = new EmbedBuilder()
    .setTitle(`🏰 던전 ${floor}층 탐사`)
    .setTimestamp();
  
  if (hasMonster) {
    // 몬스터 배틀
    const character = db.getOrCreateCharacter(userId);
    const weapon = db.getWeapon(userId);
    
    // 캐릭터 전투력 계산
    let attack = character.attack;
    let defense = character.defense;
    
    if (weapon) {
      const bonus = weapon.enhancement * 2;
      if (weapon.weapon_type === '검') attack += bonus;
      else if (weapon.weapon_type === '방패') defense += bonus;
    }
    
    const playerPower = attack + defense + (character.level * 5);
    
    // 몬스터 전투력 계산 (층이 높을수록 강함)
    const monsterBasePower = 50 + (floor * 20);
    const monsterPower = monsterBasePower + Math.floor(Math.random() * 30);
    
    // 배틀 결과
    const playerRoll = playerPower + Math.floor(Math.random() * 20);
    const monsterRoll = monsterPower + Math.floor(Math.random() * 20);
    
    // Gemini API로 배틀 멘트 생성
    let battleComment = '';
    try {
      if (genAI) {
        const model = genAI.getGenerativeModel({ model: 'gemini-2.0-flash' });
        const prompt = `판타지 RPG 게임에서 플레이어가 던전 ${floor}층에서 몬스터와 전투하는 장면을 80자 이내로 간단하고 재미있게 묘사해주세요. 한국어로 작성해주세요.`;
        const result = await model.generateContent(prompt);
        const response = await result.response;
        battleComment = response.text().trim();
        if (battleComment.length > 80) {
          battleComment = battleComment.substring(0, 77) + '...';
        }
      } else {
        battleComment = `${floor}층의 몬스터와 전투를 벌였습니다!`;
      }
    } catch (error) {
      battleComment = `${floor}층의 몬스터와 전투를 벌였습니다!`;
    }
    
    if (playerRoll > monsterRoll) {
      // 승리
      const reward = Math.floor(monsterPower / 5) + (floor * 10);
      db.addDust(userId, reward);
      db.addExp(userId, 1);
      
      // 다음 층으로 진행
      const newFloor = db.advanceDungeonFloor(userId);
      
      embed.setDescription(`⚔️ ${battleComment}\n\n` +
        `✅ 몬스터를 처치했습니다!\n\n` +
        `💰 ${reward}먼지를 획득했습니다!\n` +
        `✨ 경험치 +1\n` +
        `📈 ${newFloor}층으로 진행했습니다!\n\n` +
        `체력: ${character.current_hp}/${character.max_hp}\n` +
        `마나: ${db.getDungeonMana(userId)}/${character.max_mana || 50}`)
        .setColor(0x00FF00);
    } else {
      // 패배 - 체력 감소
      const hpBefore = character.current_hp;
      const hpAfter = db.decreaseHp(userId, 10 + floor);
      
      embed.setDescription(`⚔️ ${battleComment}\n\n` +
        `❌ 몬스터에게 패배했습니다...\n\n` +
        `💔 체력이 ${10 + floor} 감소했습니다! (${hpBefore} → ${hpAfter})\n\n` +
        `체력: ${hpAfter}/${character.max_hp}\n` +
        `마나: ${db.getDungeonMana(userId)}/${character.max_mana || 50}`)
        .setColor(0xFF0000);
      
      if (hpAfter <= 0) {
        db.resetDungeon(userId);
        embed.setDescription(embed.data.description + `\n\n⚠️ 체력이 0이 되어 던전에서 강제로 나왔습니다. 1층부터 다시 시작해야 합니다.`);
      }
    }
  } else {
    // 보상 획득
    const reward = 50 + (floor * 20) + Math.floor(Math.random() * 100);
    db.addDust(userId, reward);
    
    // 아이템 획득 확률
    const itemChance = 0.2;
    let itemReward = '';
    if (Math.random() < itemChance) {
      const items = ['강화석', '회복포션', '마나포션', '랜덤 박스'];
      const randomItem = items[Math.floor(Math.random() * items.length)];
      db.addItem(userId, randomItem, 'item', 1);
      itemReward = `\n📦 ${randomItem}을(를) 획득했습니다!`;
    }
    
    // 다음 층으로 진행
    const newFloor = db.advanceDungeonFloor(userId);
    
    embed.setDescription(`🔍 던전을 탐사했습니다...\n\n` +
      `💰 ${reward}먼지를 발견했습니다!${itemReward}\n` +
      `📈 ${newFloor}층으로 진행했습니다!\n\n` +
      `체력: ${character.current_hp}/${character.max_hp}\n` +
      `마나: ${db.getDungeonMana(userId)}/${character.max_mana || 50}`)
      .setColor(0x0099FF);
  }
  
  message.reply({ embeds: [embed] });
}

// 던전 탈출
async function handleDungeonExit(message) {
  const userId = message.author.id;
  
  if (!db.isInDungeon(userId)) {
    return message.reply('던전에 있지 않습니다.');
  }
  
  const result = db.exitDungeon(userId);
  const floor = db.getDungeonFloor(userId);
  
  const embed = new EmbedBuilder()
    .setTitle('🚪 던전 탈출!')
    .setDescription(`던전에서 나왔습니다.\n\n` +
      `탐사한 최고 층: ${floor}층\n\n` +
      `다시 던전에 진입하면 ${floor}층부터 시작할 수 있습니다.`)
    .setColor(0x00FF00)
    .setTimestamp();
  
  message.reply({ embeds: [embed] });
}

client.login(config.token);

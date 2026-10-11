/**
 * voiceSystems.js
 * ثلاثة أنظمة:
 * 1. AFK تلقائي — ينقل المدفون أكثر من X دقيقة لروم AFK
 * 2. لوحة الساعات الصوتية — Top 5 تتحدث كل 30 ثانية في قناة التفاعل
 * 3. لوقات المودريشن — يسجل كل deafen / mute / ban / timeout / move
 */

const { EmbedBuilder, AuditLogEvent } = require('discord.js');
const config = require('./config');
const attendanceStore = require('./attendanceStore');

// ─── مساعد: جيب قناة بالـ ID ──────────────────────────────────
function findChannelById(guild, channelId) {
  console.log('[ChannelSearch] Looking for channel by ID:', channelId);
  const channel = guild.channels.cache.get(channelId);
  console.log('[ChannelSearch] Found channel:', channel ? channel.name : 'null', 'ID:', channel ? channel.id : 'null');
  return channel || null;
}

// ─── مساعد: جيب قناة باسمها ──────────────────────────────────
function findChannelByName(guild, name) {
  console.log('[ChannelSearch] Looking for channel by name:', name);
  const channel = guild.channels.cache.find(
    (c) => c.name === name && c.isTextBased && c.isTextBased()
  );
  console.log('[ChannelSearch] Found channel:', channel ? channel.name : 'null', 'ID:', channel ? channel.id : 'null');
  return channel || null;
}

function findVoiceChannelByName(guild, name) {
  const { ChannelType } = require('discord.js');
  return guild.channels.cache.find(
    (c) => c.name === name && c.type === ChannelType.GuildVoice
  ) || null;
}

// ─── ١. نظام AFK ─────────────────────────────────────────────

// Map: userId -> { joinedAt, channelId, deafenedAt?, userId, live? }
const voiceSessions = new Map();

/**
 * يُستدعى عند كل VoiceStateUpdate
 */
function handleVoiceStateForSystems(oldState, newState, client) {
  const userId = newState?.member?.id || oldState?.member?.id;
  if (!userId) return;

  const member = newState?.member || oldState?.member;
  if (!member || member.user?.bot) return;

  const oldChannel = oldState?.channelId;
  const newChannel = newState?.channelId;
  const now = Date.now();

  // ─── تتبع الوقت الصوتي ───
  if (!oldChannel && newChannel) {
    // دخل روم جديد
    voiceSessions.set(userId, {
      userId,
      joinedAt: now,
      channelId: newChannel,
      deafenedAt: (newState?.selfDeaf || newState?.serverDeaf) ? now : undefined,
    });
  } else if (oldChannel && !newChannel) {
    // طلع من الروم — نحفظ الوقت حتى لو ثواني
    const session = voiceSessions.get(userId);
    if (session) {
      const seconds = Math.floor((now - session.joinedAt) / 1000);
      const minutes = Math.max(1, Math.floor(seconds / 60));
      console.log(`[Voice] ${userId} طلع من الروم — جلس ${seconds}ث = ${minutes}د — نحفظ`);
      if (seconds >= 30) attendanceStore.addVoiceMinutes(userId, minutes);
      const totalNow = attendanceStore.getVoiceMinutes(userId);
      console.log(`[Voice] ${userId} إجمالي الوقت المحفوظ = ${totalNow}د`);
      voiceSessions.delete(userId);
    } else {
      console.log(`[Voice] ${userId} طلع لكن ما في session محفوظة`);
    }
  } else if (oldChannel && newChannel && oldChannel !== newChannel) {
    // انتقل لروم ثاني — نحفظ وقت الروم السابق
    const session = voiceSessions.get(userId);
    if (session) {
      const seconds = Math.floor((now - session.joinedAt) / 1000);
      const minutes = Math.floor(seconds / 60);
      if (minutes > 0) attendanceStore.addVoiceMinutes(userId, minutes);
    }
    voiceSessions.set(userId, {
      userId,
      joinedAt: now,
      channelId: newChannel,
      deafenedAt: (newState?.selfDeaf || newState?.serverDeaf) ? now : undefined,
    });
  } else if (oldChannel && newChannel && oldChannel === newChannel) {
    // نفس الروم — تغيير حالة (mute/deaf)
    const session = voiceSessions.get(userId);
    if (!session) return;

    const wasDeafened = oldState?.selfDeaf || oldState?.serverDeaf;
    const isDeafened = newState?.selfDeaf || newState?.serverDeaf;

    if (!wasDeafened && isDeafened) {
      session.deafenedAt = now;
    } else if (wasDeafened && !isDeafened) {
      delete session.deafenedAt;
    }
  }
}

/**
 * تشغيل فحص AFK كل دقيقة
 * لو شخص مدفون أكثر من config.afkDeafenMinutes → ينقل لـ AFK
 */
function startAfkChecker(client) {
  // Map مؤقتة: userId -> وقت أول ما شفناه مدفون
  const deafSince = new Map();

  setInterval(async () => {
    const now = Date.now();
    const limitMs = 30 * 60 * 1000; // 30 دقيقة

    for (const guild of client.guilds.cache.values()) {
      const afkChannel = findVoiceChannelByName(guild, config.afkChannelName);
      if (!afkChannel) continue;

      // نجيب أحدث نسخة من voiceStates
      const voiceStates = guild.voiceStates.cache;

      for (const [userId, voiceState] of voiceStates) {
        if (!voiceState.channelId) continue;
        if (voiceState.member?.user?.bot) continue;
        if (voiceState.channelId === afkChannel.id) {
          deafSince.delete(userId);
          continue;
        }

        const isDeaf = voiceState.selfDeaf || voiceState.serverDeaf;

        if (!isDeaf) {
          deafSince.delete(userId);
          continue;
        }

        // مدفون — سجّل وقت البدء لو ما سجلنا
        if (!deafSince.has(userId)) {
          deafSince.set(userId, now);
          continue;
        }

        const elapsed = now - deafSince.get(userId);
        if (elapsed < limitMs) continue;

        // تجاوز 30 دقيقة — ننقله
        try {
          const member = voiceState.member ?? await guild.members.fetch(userId).catch(() => null);
          if (!member?.voice?.channelId) continue;
          if (member.voice.channelId === afkChannel.id) { deafSince.delete(userId); continue; }

          await member.voice.setChannel(afkChannel, 'Deafened for 30+ minutes');
          console.log(`[AFK] نقل ${userId} بعد ${Math.floor(elapsed / 60000)} دقيقة دفن`);
          deafSince.delete(userId);

          // نحسب وقته
          const session = voiceSessions.get(userId);
          if (session) {
            const minutes = Math.floor((now - session.joinedAt) / 60000);
            if (minutes > 0) attendanceStore.addVoiceMinutes(userId, minutes);
            session.joinedAt = now;
            session.channelId = afkChannel.id;
          }
        } catch (e) {
          console.error(`[AFK] فشل نقل ${userId}:`, e.message);
        }
      }

      // نمسح من deafSince أي شخص طلع من الرومات
      for (const [userId] of deafSince) {
        if (!voiceStates.has(userId) || !voiceStates.get(userId)?.channelId) {
          deafSince.delete(userId);
        }
      }
    }
  }, 30 * 1000); // فحص كل 30 ثانية
}

// ─── ٢. لوحة الساعات الصوتية ─────────────────────────────────

function buildProgressBar(minutes, maxMinutes) {
  const total = 10;
  const filled = maxMinutes > 0 ? Math.round((minutes / maxMinutes) * total) : 0;
  const empty = total - filled;
  return '█'.repeat(filled) + '░'.repeat(empty);
}

async function buildVoiceLeaderboardEmbed(client, guild, period = 'weekly') {
  const now = Date.now();

  // ١. نجيب كل الأعضاء في السيرفر (مو بوتات)
  let allMembers;
  try {
    allMembers = await guild.members.fetch();
  } catch {
    allMembers = guild.members.cache;
  }

  // ٢. نجيب الساعات المحفوظة
  const savedData = attendanceStore.getVoicePeriodLeaderboard(period);
  const minutesMap = new Map();
  for (const entry of savedData) {
    minutesMap.set(entry.userId, { totalMinutes: entry.totalMinutes, live: false });
  }

  // ٣. نضيف الوقت الحي
  for (const [userId, session] of voiceSessions) {
    const liveMinutes = Math.floor((now - session.joinedAt) / 60000);
    if (liveMinutes <= 0) continue;
    const existing = minutesMap.get(userId);
    if (existing) {
      existing.totalMinutes += liveMinutes;
      existing.live = true;
    } else {
      minutesMap.set(userId, { totalMinutes: liveMinutes, live: true });
    }
  }

  // ٤. نبني قائمة كل الأعضاء (مو بوتات)
  const entries = [];
  for (const [memberId, member] of allMembers) {
    if (member.user.bot) continue;
    const data = minutesMap.get(memberId) || { totalMinutes: 0, live: false };
    // نشوف إذا في روم الحين
    const inVoice = voiceSessions.has(memberId);
    entries.push({
      userId: memberId,
      displayName: member.displayName,
      totalMinutes: data.totalMinutes,
      live: inVoice,
    });
  }

  // ٥. نرتب من الأكثر للأقل
  entries.sort((a, b) => b.totalMinutes - a.totalMinutes);

  // ٦. نبني الـ embed — نقسم لأجزاء لأن Discord يحد الـ embed بـ 6000 حرف
  const shownEntries = entries.slice(0, 55);
  const lines = shownEntries.map((e, i) => {
    const h = Math.floor(e.totalMinutes / 60);
    const m = e.totalMinutes % 60;
    const timeStr = e.totalMinutes === 0
      ? '0h 0m'
      : h > 0 ? `${h}h ${m > 0 ? m + 'm' : ''}` : `${m}m`;
    const liveIcon = e.live ? ' 🔴' : '⚫';
    return `${liveIcon} **#${i + 1}** <@${e.userId}> — ⏱️ **${timeStr}**`;
  });

  // نقسم لـ chunks بـ 20 سطر كل chunk
  const chunkSize = 20;  const chunks = [];
  for (let i = 0; i < lines.length; i += chunkSize) {
    chunks.push(lines.slice(i, i + chunkSize).join('\n'));
  }

  const embeds = chunks.map((chunk, i) => {
    const e = new EmbedBuilder()
      .setColor(period === 'daily' ? 0x57f287 : 0x5865f2)
      .setDescription(chunk);
    if (i === 0) {
      e.setTitle(period === 'daily' ? '🏆 Daily Voice Leaderboard' : '🏆 Voice Hours Leaderboard');
    }
    if (i === chunks.length - 1) {
      e.setFooter({ text: `🔴 In voice now  •  🔄 Updates every 30s  •  Top ${shownEntries.length} of ${entries.length} members` });
      e.setTimestamp();
    }
    return e;
  });

  return embeds;
}

function riyadhDateKey(date = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Riyadh', year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
}

function currentPeriodKey(period, date = new Date()) {
  const day = riyadhDateKey(date);
  if (period === 'daily') return day;
  const [year, month, dateOfMonth] = day.split('-').map(Number);
  const monday = new Date(Date.UTC(year, month - 1, dateOfMonth));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  return `${monday.getUTCFullYear()}-${String(monday.getUTCMonth() + 1).padStart(2, '0')}-${String(monday.getUTCDate()).padStart(2, '0')}`;
}

function formatVoiceTime(totalMinutes) {
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  return hours ? `${hours}h ${minutes ? `${minutes}m` : ''}` : `${minutes}m`;
}

async function publishWinners(channel, period, key, winners, previousState) {
  if (previousState?.winnerMessageId && previousState.channelId === channel.id) {
    const oldMessage = await channel.messages.fetch(previousState.winnerMessageId).catch(() => null);
    if (oldMessage) await oldMessage.delete().catch(() => {});
  }
  const title = period === 'daily' ? '🏆 Daily Voice Winners' : '🏆 Weekly Voice Leaderboard';
  const medals = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣', '6️⃣', '7️⃣'];
  const winnerLimit = period === 'daily' ? 5 : 7;
  const description = winners.length
    ? winners.slice(0, winnerLimit).map((entry, index) => `${medals[index]} **${index < 3 ? 'Congratulations!' : '💪 Hard Luck!'}**\n└ <@${entry.userId}> — ⏱️ **${formatVoiceTime(entry.totalMinutes)}**`).join('\n\n')
    : 'No voice activity was recorded in this period.';
  const message = await channel.send({ embeds: [new EmbedBuilder().setColor(period === 'daily' ? 0x57f287 : 0xffc107).setTitle(title).setDescription(description).setFooter({ text: `Top ${Math.min(winners.length, winnerLimit)} members • Period ending ${key}` }).setTimestamp()] });
  return message.id;
}

async function updatePeriodBoard(client, guild, period, channelName) {
  const channel = findChannelByName(guild, channelName);
  if (!channel) return;
  let state = attendanceStore.getVoicePeriod(period);
  const key = currentPeriodKey(period);
  if (!state.key) {
    state.key = key;
    state.minutes = state.minutes || {};
    attendanceStore.setVoicePeriod(period, state);
  } else if (state.key !== key) {
    // Preserve the final partial sessions in the period being closed.
    const now = Date.now();
    for (const session of voiceSessions.values()) {
      const minutes = Math.floor((now - session.joinedAt) / 60000);
      if (minutes > 0) attendanceStore.addVoiceMinutes(session.userId, minutes);
      session.joinedAt = now;
    }
    state = attendanceStore.getVoicePeriod(period);
    const winners = attendanceStore.getVoicePeriodLeaderboard(period);
    const winnerMessageId = await publishWinners(channel, period, state.key, winners, state);
    state = { ...state, key, minutes: {}, winnerMessageId, channelId: channel.id, boardMessageIds: [] };
    attendanceStore.setVoicePeriod(period, state);
  }

  const embeds = await buildVoiceLeaderboardEmbed(client, guild, period);
  const current = attendanceStore.getVoicePeriod(period);
  const ids = current.boardMessageIds || [];
  let success = ids.length === embeds.length;
  if (success) {
    for (let i = 0; i < ids.length; i++) {
      const message = await channel.messages.fetch(ids[i]).catch(() => null);
      if (!message) { success = false; break; }
      await message.edit({ embeds: [embeds[i]] }).catch(() => { success = false; });
      if (!success) break;
    }
  }
  if (success) return;
  for (const id of ids) {
    const message = await channel.messages.fetch(id).catch(() => null);
    if (message) await message.delete().catch(() => {});
  }
  const newIds = [];
  for (const embed of embeds) {
    const message = await channel.send({ embeds: [embed] }).catch((error) => {
      console.error(`[Leaderboard:${period}] Failed to publish:`, error.message);
      return null;
    });
    if (message) newIds.push(message.id);
  }
  current.boardMessageIds = newIds;
  current.channelId = channel.id;
  attendanceStore.setVoicePeriod(period, current);
}

async function updateVoiceLeaderboard(client) {
  for (const guild of client.guilds.cache.values()) {
    await updatePeriodBoard(client, guild, 'daily', config.dailyVoiceLeaderboardChannelName);
    await updatePeriodBoard(client, guild, 'weekly', config.voiceLeaderboardChannelName);
  }
}

function startVoiceLeaderboard(client) {
  setTimeout(() => updateVoiceLeaderboard(client).catch((e) => console.error('[Leaderboard] Update failed:', e)), 5000);
  setInterval(() => updateVoiceLeaderboard(client).catch((e) => console.error('[Leaderboard] Update failed:', e)), 30 * 1000);
}

// ─── ٣. لوقات المودريشن ──────────────────────────────────────

async function getModLogChannel(guild) {
  return findChannelByName(guild, config.modLogChannelName);
}

async function sendModLog(guild, embed) {
  const channel = await getModLogChannel(guild);
  if (!channel) {
    console.log('[ModLog] Channel not found:', config.modLogChannelName);
    return;
  }
  console.log('[ModLog] Sending to channel:', channel.name, 'ID:', channel.id);
  await channel.send({ embeds: [embed] }).catch((error) => {
    console.error('[ModLog] Failed to send log:', error.message);
  });
}

// ─── ٤. لوقات الرتب ──────────────────────────────────────────────

async function getRolesLogChannel(guild) {
  return findChannelById(guild, config.rolesLogChannelId);
}

async function sendRolesLog(guild, embed) {
  const channel = await getRolesLogChannel(guild);
  if (!channel) {
    console.log('[RoleLog] Channel not found by ID:', config.rolesLogChannelId);
    return;
  }
  console.log('[RoleLog] Sending to channel:', channel.name, 'ID:', channel.id);
  await channel.send({ embeds: [embed] }).catch((error) => {
    console.error('[RoleLog] Failed to send log:', error.message);
  });
}

// ─── ٥. لوقات العقوبات ───────────────────────────────────────────

async function getPunishmentLogChannel(guild) {
  return findChannelById(guild, config.punishmentLogChannelId);
}

async function sendPunishmentLog(guild, embed) {
  const channel = await getPunishmentLogChannel(guild);
  if (!channel) {
    console.log('[PunishmentLog] Channel not found by ID:', config.punishmentLogChannelId);
    return;
  }
  console.log('[PunishmentLog] Sending to channel:', channel.name, 'ID:', channel.id);
  await channel.send({ embeds: [embed] }).catch((error) => {
    console.error('[PunishmentLog] Failed to send log:', error.message);
  });
}

/**
 * يُستدعى عند GuildAuditLogEntryCreate
 * يراقب: BAN / UNBAN / TIMEOUT / MEMBER_UPDATE (mute/deafen) / MEMBER_DISCONNECT / MEMBER_MOVE
 */
async function handleAuditLog(entry, guild) {
  try {
    const { action, executor, target, changes, reason, extra } = entry;

    console.log('[ModLog] Audit log entry received:', { action, executor: executor?.tag, target: target?.id });

    // تجاهل أفعال البوت نفسه
    if (executor?.bot) {
      console.log('[ModLog] Ignoring bot action');
      return;
    }

    // التحقق من وجود target
    if (!target || !target.id) {
      console.log('[ModLog] Target is null or missing id, skipping');
      return;
    }

    // التحقق من وجود executor
    if (!executor || !executor.id) {
      console.log('[ModLog] Executor is null or missing id, skipping');
      return;
    }

    let embed = null;

    // ─── BAN ───
    if (action === AuditLogEvent.MemberBanAdd) {
      embed = new EmbedBuilder()
        .setColor(0xed4245)
        .setTitle('🔨 باند')
        .addFields(
          { name: '👤 المفعول به', value: `<@${target.id}> (${target.tag || target.id})`, inline: true },
          { name: '🛡️ الفاعل', value: `<@${executor.id}> (${executor.tag || executor.id})`, inline: true },
          { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
        )
        .setTimestamp();

      // إرسال لوق العقوبات أيضاً
      await sendPunishmentLog(guild, embed);
    }

    // ─── UNBAN ───
    else if (action === AuditLogEvent.MemberBanRemove) {
      embed = new EmbedBuilder()
        .setColor(0x57f287)
        .setTitle('✅ رفع باند')
        .addFields(
          { name: '👤 المفعول به', value: `<@${target.id}> (${target.tag || target.id})`, inline: true },
          { name: '🛡️ الفاعل', value: `<@${executor.id}> (${executor.tag || executor.id})`, inline: true },
          { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
        )
        .setTimestamp();

      // إرسال لوق العقوبات أيضاً
      await sendPunishmentLog(guild, embed);
    }

  // ─── TIMEOUT ───
  else if (action === AuditLogEvent.MemberUpdate) {
    if (!changes || changes.length === 0) return;

    for (const change of changes) {
      // Timeout
      if (change.key === 'communication_disabled_until') {
        const wasTimedOut = change.old != null;
        const isTimedOut = change.new != null;

        if (!wasTimedOut && isTimedOut) {
          // تايم اوت جديد
          const until = new Date(change.new);
          const unixTs = Math.floor(until.getTime() / 1000);
          embed = new EmbedBuilder()
            .setColor(0xfee75c)
            .setTitle('⏱️ تايم اوت')
            .addFields(
              { name: '👤 المفعول به', value: `<@${target.id}>`, inline: true },
              { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
              { name: '⏰ ينتهي', value: `<t:${unixTs}:R>`, inline: false },
              { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
            )
            .setTimestamp();
          await sendModLog(guild, embed);
          await sendPunishmentLog(guild, embed);
          return;
        } else if (wasTimedOut && !isTimedOut) {
          // رفع تايم اوت
          embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('✅ رفع تايم اوت')
            .addFields(
              { name: '👤 المفعول به', value: `<@${target.id}>`, inline: true },
              { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true }
            )
            .setTimestamp();
          await sendModLog(guild, embed);
          await sendPunishmentLog(guild, embed);
          return;
        }
      }

      // Server Mute
      if (change.key === 'mute') {
        const isMuted = change.new === true;
        embed = new EmbedBuilder()
          .setColor(isMuted ? 0xff9800 : 0x57f287)
          .setTitle(isMuted ? '🔇 ميوت' : '🔊 رفع ميوت')
          .addFields(
            { name: '👤 المفعول به', value: `<@${target.id}>`, inline: true },
            { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
            { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
          )
          .setTimestamp();
        await sendModLog(guild, embed);
        return;
      }

      // Server Deafen (دفن)
      if (change.key === 'deaf') {
        const isDeafened = change.new === true;
        embed = new EmbedBuilder()
          .setColor(isDeafened ? 0x9b59b6 : 0x57f287)
          .setTitle(isDeafened ? '🔕 دفن' : '🔔 رفع دفن')
          .addFields(
            { name: '👤 المفعول به', value: `<@${target.id}>`, inline: true },
            { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
            { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
          )
          .setTimestamp();
        await sendModLog(guild, embed);
        return;
      }
    }
    return; // ما في تغيير يهمنا
  }

  // ─── KICK ───
  else if (action === AuditLogEvent.MemberKick) {
    embed = new EmbedBuilder()
      .setColor(0xe67e22)
      .setTitle('👟 كيك')
      .addFields(
        { name: '👤 المفعول به', value: `<@${target.id}> (${target.tag || target.id})`, inline: true },
        { name: '🛡️ الفاعل', value: `<@${executor.id}> (${executor.tag || executor.id})`, inline: true },
        { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
      )
      .setTimestamp();

    // إرسال لوق العقوبات أيضاً
    await sendPunishmentLog(guild, embed);
  }

  // ─── MEMBER MOVE (نقل من روم لروم) ───
  else if (action === AuditLogEvent.MemberMove) {
    const count = extra?.count || 1;
    embed = new EmbedBuilder()
      .setColor(0x3498db)
      .setTitle('🚀 نقل من روم لروم')
      .addFields(
        { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
        { name: '📍 الروم الجديد', value: extra?.channel ? `<#${extra.channel.id}>` : 'غير معروف', inline: true },
        { name: '👥 عدد المنقولين', value: String(count), inline: true }
      )
      .setTimestamp();
  }

  // ─── MEMBER DISCONNECT (طرد من الروم الصوتي) ───
  else if (action === AuditLogEvent.MemberDisconnect) {
    const count = extra?.count || 1;
    embed = new EmbedBuilder()
      .setColor(0x95a5a6)
      .setTitle('📵 طرد من الروم الصوتي')
      .addFields(
        { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
        { name: '👥 عدد المطرودين', value: String(count), inline: true }
      )
      .setTimestamp();
  }

  if (embed) {
    await sendModLog(guild, embed);
  }
  } catch (error) {
    console.error('[ModLog] Error in handleAuditLog:', error.message);
    console.error('[ModLog] Error stack:', error.stack);
  }
}

/**
 * يُستدعى عند GuildAuditLogEntryCreate للوقات الرتب
 * يراقب: ROLE_UPDATE (إضافة/إزالة رتب)
 */
async function handleRoleLog(entry, guild) {
  try {
    const { action, executor, target, changes, reason } = entry;

    console.log('[RoleLog] Audit log entry received:', { action, executor: executor?.tag, target: target?.id });

    // تجاهل أفعال البوت نفسه
    if (executor?.bot) {
      console.log('[RoleLog] Ignoring bot action');
      return;
    }

    // التحقق من وجود target
    if (!target || !target.id) {
      console.log('[RoleLog] Target is null or missing id, skipping');
      return;
    }

    // التحقق من وجود executor
    if (!executor || !executor.id) {
      console.log('[RoleLog] Executor is null or missing id, skipping');
      return;
    }

    // فقط للوقات الرتب
    if (action !== AuditLogEvent.MemberRoleUpdate) {
      console.log('[RoleLog] Not a role update, action:', action);
      return;
    }

    if (!changes || changes.length === 0) {
      console.log('[RoleLog] No changes detected');
      return;
    }

    console.log('[RoleLog] Role update detected, changes:', changes.map(c => c.key));

    // التحقق من التغييرات في الرتب
    const roleChanges = changes.filter(change => change.key === '$add' || change.key === '$remove');
    if (roleChanges.length === 0) {
      console.log('[RoleLog] No role changes found');
      return;
    }

    console.log('[RoleLog] Processing role changes:', roleChanges.length);

    for (const change of roleChanges) {
      const addedRoles = change.key === '$add' ? change.new : [];
      const removedRoles = change.key === '$remove' ? change.new : [];

      console.log('[RoleLog] Added roles:', addedRoles.length, 'Removed roles:', removedRoles.length);

      if (addedRoles.length > 0) {
        for (const role of addedRoles) {
          console.log('[RoleLog] Sending role add log for role:', role.name);
          const embed = new EmbedBuilder()
            .setColor(0x57f287)
            .setTitle('➕ إضافة رتبة')
            .addFields(
              { name: '👤 العضو', value: `<@${target.id}>`, inline: true },
              { name: '🏷️ الرتبة', value: `<@&${role.id}> (${role.name})`, inline: true },
              { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
              { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
            )
            .setTimestamp();
          await sendRolesLog(guild, embed);
        }
      }

      if (removedRoles.length > 0) {
        for (const role of removedRoles) {
          console.log('[RoleLog] Sending role remove log for role:', role.name);
          const embed = new EmbedBuilder()
            .setColor(0xed4245)
            .setTitle('➖ إزالة رتبة')
            .addFields(
              { name: '👤 العضو', value: `<@${target.id}>`, inline: true },
              { name: '🏷️ الرتبة', value: `<@&${role.id}> (${role.name})`, inline: true },
              { name: '🛡️ الفاعل', value: `<@${executor.id}>`, inline: true },
              { name: '📋 السبب', value: reason || 'بدون سبب', inline: false }
            )
            .setTimestamp();
          await sendRolesLog(guild, embed);
        }
      }
    }
  } catch (error) {
    console.error('[RoleLog] Error in handleRoleLog:', error.message);
    console.error('[RoleLog] Error stack:', error.stack);
  }
}

/**
 * يُستدعى عند ClientReady لتسجيل من هو في الرومات الحين
 */
function initVoiceSessions(client) {
  const now = Date.now();
  for (const guild of client.guilds.cache.values()) {
    for (const [, voiceState] of guild.voiceStates.cache) {
      if (!voiceState.channelId) continue;
      if (voiceState.member?.user?.bot) continue;
      const userId = voiceState.id;
      const isDeaf = voiceState.selfDeaf || voiceState.serverDeaf;
      voiceSessions.set(userId, {
        userId,
        joinedAt: now,
        channelId: voiceState.channelId,
        // لو مدفون من الأول نبدأ العداد من الحين
        deafenedAt: isDeaf ? now : undefined,
      });
      console.log(`[Init] ${userId} — deaf: ${isDeaf} — channel: ${voiceState.channelId}`);
    }
  }
  console.log(`[VoiceSessions] تم تسجيل ${voiceSessions.size} شخص في الرومات عند البدء`);
}

module.exports = {
  handleVoiceStateForSystems,
  initVoiceSessions,
  startAfkChecker,
  startVoiceLeaderboard,
  handleAuditLog,
  handleRoleLog,
};

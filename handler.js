/**
 * Message Handler - Processes incoming messages and executes commands
 */

const config = require('./config');
const database = require('./database');
const { loadCommands } = require('./utils/commandLoader');
const { addMessage } = require('./utils/groupstats');
const { tryAutoLevelUp, formatLevelUpMessage, linkJids } = require('./utils/economy');
const { jidDecode, jidEncode } = require('@whiskeysockets/baileys');
const fs = require('fs');
const path = require('path');
const axios = require('axios');
const chatbotCmd = require('./commands/admin/chatbot');
const { containsBadWord } = require('./utils/badwords');
const { writeExifImg } = require('./utils/exif');
const { msgHasLink } = require('./utils/linkDetect');
const APIs = require('./utils/api');
const { resolveJoinLeaveTarget, toMention } = require('./utils/funHelpers');
const { rememberFromMessage, rememberContact } = require('./utils/nameCache');
const groupStatusTracker = require('./utils/groupStatusTracker');

// Group metadata cache to prevent rate limiting
const groupMetadataCache = new Map();
const CACHE_TTL = 60000; // 1 minute cache

// Load all commands
const commands = loadCommands();

const ANTIBADWORD_STICKER_PATH = path.join(__dirname, 'utils', 'galimatde.webp');
const ANTIBADWORD_STICKER_AUTHOR = 'GALI MAT DE BSDK';
let antibadwordStickerCache = null;

const getAntibadwordSticker = async () => {
  try {
    if (!antibadwordStickerCache && fs.existsSync(ANTIBADWORD_STICKER_PATH)) {
      const raw = fs.readFileSync(ANTIBADWORD_STICKER_PATH);
      antibadwordStickerCache = await writeExifImg(raw, { packname: ANTIBADWORD_STICKER_AUTHOR });
    }
  } catch (e) {
    console.error('[antibadword] sticker load error:', e.message);
  }
  return antibadwordStickerCache;
};

// Unwrap WhatsApp containers (ephemeral, view once, etc.)
const getMessageContent = (msg) => {
  if (!msg || !msg.message) return null;
  
  let m = msg.message;
  
  // Common wrappers in modern WhatsApp
  if (m.ephemeralMessage) m = m.ephemeralMessage.message;
  if (m.viewOnceMessageV2) m = m.viewOnceMessageV2.message;
  if (m.viewOnceMessage) m = m.viewOnceMessage.message;
  if (m.documentWithCaptionMessage) m = m.documentWithCaptionMessage.message;
  
  // You can add more wrappers if needed later
  return m;
};

// Cached group metadata getter with rate limit handling (for non-admin checks)
const getCachedGroupMetadata = async (sock, groupId) => {
  try {
    // Validate group JID before attempting to fetch
    if (!groupId || !groupId.endsWith('@g.us')) {
      return null;
    }
    
    // Check cache first
    const cached = groupMetadataCache.get(groupId);
    if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
      return cached.data; // Return cached data (even if null for forbidden groups)
    }
    
    // Fetch from API
    const metadata = await sock.groupMetadata(groupId);
    for (const p of metadata?.participants || []) rememberContact(p);
    
    // Cache it
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // Handle forbidden (403) errors - cache null to prevent retry storms
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Cache null for forbidden groups to prevent repeated attempts
      groupMetadataCache.set(groupId, {
        data: null,
        timestamp: Date.now()
      });
      return null; // Silently return null for forbidden groups
    }
    
    // Handle rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      const cached = groupMetadataCache.get(groupId);
      if (cached) {
        return cached.data;
      }
      return null;
    }
    
    // For other errors, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    
    // Return null instead of throwing to prevent crashes
    return null;
  }
};

// Live group metadata getter (always fresh, no cache) - for admin checks
const getLiveGroupMetadata = async (sock, groupId) => {
  try {
    // Always fetch fresh metadata, bypass cache
    const metadata = await (sock.rawGroupMetadata || sock.groupMetadata)(groupId);
    for (const p of metadata?.participants || []) rememberContact(p);
    
    // Update cache for other features (antilink, welcome, etc.)
    groupMetadataCache.set(groupId, {
      data: metadata,
      timestamp: Date.now()
    });
    
    return metadata;
  } catch (error) {
    // On error, try cached data as fallback
    const cached = groupMetadataCache.get(groupId);
    if (cached) {
      return cached.data;
    }
    return null;
  }
};

// Alias for backward compatibility (non-admin features use cached)
const getGroupMetadata = getCachedGroupMetadata;

const peekGroupMetadata = (groupId) => {
  const cached = groupMetadataCache.get(groupId);
  return cached?.data || undefined;
};

const recentJoinLeaveCards = new Map();

const isSocketOpen = (sock) => !!(sock?.ws?.isOpen || sock?.ws?.readyState === 1);

const isConnectionDeadError = (error) => {
  const message = String(error?.message || error || '');
  return /connection closed|precondition required|timed out|socket/i.test(message)
    || error?.output?.statusCode === 428;
};

const isTransientGroupError = (error) => {
  const message = String(error?.message || error || '');
  return /forbidden|403|not-authorized|connection closed|precondition required|timed out|rate-overlimit/i.test(message)
    || error?.data === 403
    || error?.statusCode === 403
    || error?.output?.statusCode === 403
    || isConnectionDeadError(error);
};

const sendGroupCard = async (sock, groupId, payload, groupMetadata) => {
  if (!isSocketOpen(sock)) return;
  if (groupMetadata) {
    groupMetadataCache.set(groupId, { data: groupMetadata, timestamp: Date.now() });
  }
  try {
    await sock.sendMessage(groupId, payload);
    return;
  } catch (error) {
    if (isConnectionDeadError(error) || !isSocketOpen(sock)) return;
    if (!payload.mentions || !isTransientGroupError(error)) throw error;
    const { mentions, ...rest } = payload;
    if (!isSocketOpen(sock)) return;
    await sock.sendMessage(groupId, rest);
  }
};

// Helper functions
const isOwner = (sender) => {
  if (!sender) return false;
  
  // Normalize sender JID to handle LID
  const normalizedSender = normalizeJidWithLid(sender);
  const senderNumber = normalizeJid(normalizedSender);
  
  // Check against owner numbers
  return config.ownerNumber.some(owner => {
    const normalizedOwner = normalizeJidWithLid(owner.includes('@') ? owner : `${owner}@s.whatsapp.net`);
    const ownerNumber = normalizeJid(normalizedOwner);
    return ownerNumber === senderNumber;
  });
};

const isMod = (sender) => {
  const number = sender.split('@')[0];
  return database.isModerator(number);
};

// LID mapping cache
const lidMappingCache = new Map();

// Helper to normalize JID to just the number part
const normalizeJid = (jid) => {
  if (!jid) return null;
  if (typeof jid !== 'string') return null;
  
  // Remove device ID if present (e.g., "1234567890:0@s.whatsapp.net" -> "1234567890")
  if (jid.includes(':')) {
    return jid.split(':')[0];
  }
  // Remove domain if present (e.g., "1234567890@s.whatsapp.net" -> "1234567890")
  if (jid.includes('@')) {
    return jid.split('@')[0];
  }
  return jid;
};

// Get LID mapping value from session files
const getLidMappingValue = (user, direction) => {
  if (!user) return null;
  
  const cacheKey = `${direction}:${user}`;
  if (lidMappingCache.has(cacheKey)) {
    return lidMappingCache.get(cacheKey);
  }
  
  const sessionPath = path.join(__dirname, config.sessionName || 'session');
  const suffix = direction === 'pnToLid' ? '.json' : '_reverse.json';
  const filePath = path.join(sessionPath, `lid-mapping-${user}${suffix}`);
  
  if (!fs.existsSync(filePath)) {
    lidMappingCache.set(cacheKey, null);
    return null;
  }
  
  try {
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    const value = raw ? JSON.parse(raw) : null;
    lidMappingCache.set(cacheKey, value || null);
    return value || null;
  } catch (error) {
    lidMappingCache.set(cacheKey, null);
    return null;
  }
};

// Normalize JID handling LID conversion
const normalizeJidWithLid = (jid) => {
  if (!jid) return jid;
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return `${jid.split(':')[0].split('@')[0]}@s.whatsapp.net`;
    }
    
    let user = decoded.user;
    let server = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    const mapToPn = () => {
      const pnUser = getLidMappingValue(user, 'lidToPn');
      if (pnUser) {
        user = pnUser;
        server = server === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        return true;
      }
      return false;
    };
    
    if (server === 'lid' || server === 'hosted.lid') {
      mapToPn();
    } else if (server === 's.whatsapp.net' || server === 'hosted') {
      mapToPn();
    }
    
    if (server === 'hosted') {
      return jidEncode(user, 'hosted');
    }
    return jidEncode(user, 's.whatsapp.net');
  } catch (error) {
    return jid;
  }
};

// Build comparable JID variants (PN + LID) for matching
const buildComparableIds = (jid) => {
  if (!jid) return [];
  
  try {
    const decoded = jidDecode(jid);
    if (!decoded?.user) {
      return [normalizeJidWithLid(jid)].filter(Boolean);
    }
    
    const variants = new Set();
    const normalizedServer = decoded.server === 'c.us' ? 's.whatsapp.net' : decoded.server;
    
    variants.add(jidEncode(decoded.user, normalizedServer));
    
    const isPnServer = normalizedServer === 's.whatsapp.net' || normalizedServer === 'hosted';
    const isLidServer = normalizedServer === 'lid' || normalizedServer === 'hosted.lid';
    
    if (isPnServer) {
      const lidUser = getLidMappingValue(decoded.user, 'pnToLid');
      if (lidUser) {
        const lidServer = normalizedServer === 'hosted' ? 'hosted.lid' : 'lid';
        variants.add(jidEncode(lidUser, lidServer));
      }
    } else if (isLidServer) {
      const pnUser = getLidMappingValue(decoded.user, 'lidToPn');
      if (pnUser) {
        const pnServer = normalizedServer === 'hosted.lid' ? 'hosted' : 's.whatsapp.net';
        variants.add(jidEncode(pnUser, pnServer));
      }
    }
    
    return Array.from(variants);
  } catch (error) {
    return [jid];
  }
};

// Check if a JID belongs to the bot (handles PN/LID/device IDs)
const isBotJid = (jid, sock) => {
  if (!jid || !sock?.user) return false;
  const botRefs = [sock.user.id, sock.user.lid].filter(Boolean);
  const targetVariants = buildComparableIds(jid);
  return botRefs.some(botRef =>
    buildComparableIds(botRef).some(botVariant => targetVariants.includes(botVariant))
  );
};

// Find participant by either PN JID or LID JID
const findParticipant = (participants = [], userIds) => {
  const targets = (Array.isArray(userIds) ? userIds : [userIds])
    .filter(Boolean)
    .flatMap(id => buildComparableIds(id));
  
  if (!targets.length) return null;
  
  return participants.find(participant => {
    if (!participant) return false;
    
    const participantIds = [
      participant.id,
      participant.lid,
      participant.userJid
    ]
      .filter(Boolean)
      .flatMap(id => buildComparableIds(id));
    
    return participantIds.some(id => targets.includes(id));
  }) || null;
};

const isAdmin = async (sock, participant, groupId, groupMetadata = null) => {
  if (!participant) return false;
  
  // Early return for non-group JIDs (DMs) - prevents slow sock.groupMetadata() call
  if (!groupId || !groupId.endsWith('@g.us')) {
    return false;
  }
  
  // Always fetch live metadata for admin checks
  let liveMetadata = groupMetadata;
  if (!liveMetadata || !liveMetadata.participants) {
    if (groupId) {
      liveMetadata = await getLiveGroupMetadata(sock, groupId);
    } else {
      return false;
    }
  }
  
  if (!liveMetadata || !liveMetadata.participants) return false;
  
  // Use findParticipant to handle LID matching
  const foundParticipant = findParticipant(liveMetadata.participants, participant);
  if (!foundParticipant) return false;
  
  return foundParticipant.admin === 'admin' || foundParticipant.admin === 'superadmin';
};

const isBotAdmin = async (sock, groupId, groupMetadata = null) => {
  if (!sock.user || !groupId) return false;
  
  // Early return for non-group JIDs (DMs) - prevents slow sock.groupMetadata() call
  if (!groupId.endsWith('@g.us')) {
    return false;
  }
  
  try {
    // Get bot's JID - Baileys stores it in sock.user.id
    const botId = sock.user.id;
    const botLid = sock.user.lid;
    
    if (!botId) return false;
    
    // Prepare bot JIDs to check - findParticipant will normalize them via buildComparableIds
    const botJids = [botId];
    if (botLid) {
      botJids.push(botLid);
    }
    
    // ALWAYS fetch live metadata for bot admin checks (never use cached)
    const liveMetadata = await getLiveGroupMetadata(sock, groupId);
    
    if (!liveMetadata || !liveMetadata.participants) return false;
    
    const participant = findParticipant(liveMetadata.participants, botJids);
    if (!participant) return false;
    
    return participant.admin === 'admin' || participant.admin === 'superadmin';
  } catch (error) {
    return false;
  }
};

const isUrl = (text) => {
  const urlRegex = /(https?:\/\/[^\s]+)/gi;
  return urlRegex.test(text);
};

const hasGroupLink = (text) => {
  const linkRegex = /chat.whatsapp.com\/([0-9A-Za-z]{20,24})/i;
  return linkRegex.test(text);
};

// System JID filter - checks if JID is from broadcast/status/newsletter
const isSystemJid = (jid) => {
  if (!jid) return true;
  return jid.includes('@broadcast') || 
         jid.includes('status.broadcast') || 
         jid.includes('@newsletter') ||
         jid.includes('@newsletter.');
};

// Main message handler
const handleMessage = async (sock, msg) => {
  try {
    // Debug logging to see all messages
    // Debug log removed
    
    if (!msg.message) return;
    rememberFromMessage(msg);
    
    const from = msg.key.remoteJid;
    
    // System message filter - ignore broadcast/status/newsletter messages
    if (isSystemJid(from)) {
      return; // Silently ignore system messages
    }
    
    // Auto-React System
    try {
      // Clear cache to get fresh config values
      delete require.cache[require.resolve('./config')];
      const config = require('./config');

      if (config.autoReact && msg.message && !msg.key.fromMe) {
        const content = msg.message.ephemeralMessage?.message || msg.message;
        const text =
          content.conversation ||
          content.extendedTextMessage?.text ||
          '';

        const jid = msg.key.remoteJid;
        const emojis = ['❤️','🔥','👌','💀','😁','✨','👍','🤨','😎','😂','🤝','💫'];
        
        const mode = config.autoReactMode || 'bot';

        if (mode === 'bot') {
          const prefixList = ['.', '/', '#'];
          if (prefixList.includes(text?.trim()[0])) {
            await sock.sendMessage(jid, {
              react: { text: '⏳', key: msg.key }
            });
          }
        }

        if (mode === 'all') {
          const rand = emojis[Math.floor(Math.random() * emojis.length)];
          await sock.sendMessage(jid, {
            react: { text: rand, key: msg.key }
          });
        }
      }
    } catch (e) {
      console.error('[AutoReact Error]', e.message);
    }
    
    // Unwrap containers first
    const content = getMessageContent(msg);
    // Note: We don't return early if content is null because forwarded status messages might not have content
    
    // Still check for actual message content for regular processing
    let actualMessageTypes = [];
    if (content) {
      const allKeys = Object.keys(content);
      // Filter out protocol/system messages and find actual message content
      const protocolMessages = ['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'];
      actualMessageTypes = allKeys.filter(key => !protocolMessages.includes(key));
    }
    
    // We'll check for empty content later after we've processed group messages
    
    // Use the first actual message type (conversation, extendedTextMessage, etc.)
    const messageType = actualMessageTypes[0];
    
    // from already defined above in DM block check
    const isGroup = from.endsWith('@g.us'); // Should always be true now due to DM block above
    
    // Fetch group metadata immediately if it's a group
    const groupMetadata = isGroup ? await getGroupMetadata(sock, from) : null;

    // fromMe used to always become phone@s.whatsapp.net, while pay/mentions store coins on @lid
    let sender = msg.key.fromMe
      ? (sock.user.id || '').split(':')[0] + '@s.whatsapp.net'
      : msg.key.participant || msg.key.remoteJid;
    if (msg.key.fromMe && sock.user && isGroup) {
      const pn = (sock.user.id || '').split(':')[0] + '@s.whatsapp.net';
      const lid = sock.user.lid;
      const ids = [pn, lid];
      const p = findParticipant(groupMetadata?.participants || [], [sock.user.id, lid, pn]);
      if (p) ids.push(p.lid, p.id, p.userJid);
      sender = linkJids(from, ids) || lid || pn;
    }

    // PM Blocker — warn + auto-block non-owner/sudo DMs
    if (!isGroup && !msg.key.fromMe) {
      try {
        const pmblocker = require('./utils/pmblocker');
        const exempt = isOwner(sender) || database.isSudoUser(sender);
        if (await pmblocker.handleDm(sock, msg, { isExempt: exempt })) return;
      } catch (e) {
        console.warn('[pmblocker] handler error:', e.message);
      }
    }

    // Anti-group status (block group status posts)
    if (isGroup && !msg.key.fromMe) {
      try {
        const blocked = await handleAntigroupstatus(sock, msg, groupMetadata, content);
        if (blocked) return;
      } catch (error) {
        console.error('Error in antigroupstatus handler:', error);
      }
    }

    // Anti-sticker (block stickers from non-admins)
    if (isGroup && !msg.key.fromMe) {
      try {
        const blocked = await handleAntisticker(sock, msg, groupMetadata, content);
        if (blocked) return;
      } catch (error) {
        console.error('Error in antisticker handler:', error);
      }
    }

    // Antibot — other Baileys bots (message-ID heuristic)
    if (isGroup && !msg.key.fromMe) {
      try {
        const blocked = await handleAntibot(sock, msg, groupMetadata, sender);
        if (blocked) return;
      } catch (error) {
        console.error('Error in antibot handler:', error);
      }
    }

    // Antispam — fast bursts or repeated text
    if (isGroup && !msg.key.fromMe) {
      try {
        const blocked = await handleAntispam(sock, msg, groupMetadata, sender, content);
        if (blocked) return;
      } catch (error) {
        console.error('Error in antispam handler:', error);
      }
    }
    
    // Anti-group mention protection (check BEFORE prefix check, as these are non-command messages)
    if (isGroup) {
      // Debug logging to confirm we're trying to call the handler
      const groupSettings = database.getGroupSettings(from);
      // Debug log removed
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      try {
        await handleAntigroupmention(sock, msg, groupMetadata);
      } catch (error) {
        console.error('Error in antigroupmention handler:', error);
      }
    }
    
    // Track group message statistics
    if (isGroup) {
      const ctx = content?.extendedTextMessage?.contextInfo;
      addMessage(from, sender, {
        mentions: ctx?.mentionedJid || [],
        sticker: !!(content?.stickerMessage || msg.message?.stickerMessage),
      });

      // Auto level-up when enough XP (economy ranks)
      if (!msg.key.fromMe) {
        try {
          const levelResult = tryAutoLevelUp(from, sender);
          if (levelResult.leveled) {
            await sock.sendMessage(from, {
              text: formatLevelUpMessage(
                levelResult.before,
                levelResult.after,
                levelResult.role,
                levelResult.diamondsEarned
              ),
              mentions: [sender],
            }, { quoted: msg });
          }
        } catch (e) {
          // ignore autolevel errors
        }
      }
    }
    
    // Return early for non-group messages with no recognizable content
    if (!content || actualMessageTypes.length === 0) return;
    
    // 🔹 Button response should also check unwrapped content
    const btn = content.buttonsResponseMessage || msg.message?.buttonsResponseMessage;
    if (btn) {
      const buttonId = btn.selectedButtonId;
      const displayText = btn.selectedDisplayText;
      
      // Handle button clicks by routing to commands
      if (buttonId === 'btn_menu') {
        // Execute menu command
        const menuCmd = commands.get('menu');
        if (menuCmd) {
          await menuCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      } else if (buttonId === 'btn_ping') {
        // Execute ping command
        const pingCmd = commands.get('ping');
        if (pingCmd) {
          await pingCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      } else if (buttonId === 'btn_help') {
        // Execute list command again (help)
        const listCmd = commands.get('list');
        if (listCmd) {
          await listCmd.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
        }
        return;
      }
    }
    
    // Get message body from unwrapped content
    let body = '';
    if (content.conversation) {
      body = content.conversation;
    } else if (content.extendedTextMessage) {
      body = content.extendedTextMessage.text || '';
    } else if (content.imageMessage) {
      body = content.imageMessage.caption || '';
    } else if (content.videoMessage) {
      body = content.videoMessage.caption || '';
    }
    
    body = (body || '').trim();
    
    // Check antiall protection (owner only feature)
    if (isGroup) {
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.antiall) {
        const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
        const senderIsOwner = isOwner(sender);
        
        if (!senderIsAdmin && !senderIsOwner) {
          const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
          if (botIsAdmin) {
            await sock.sendMessage(from, { delete: msg.key });
            return;
          }
        }
      }
      
      // Anti-tag protection (check BEFORE text check, as tagall can have no text)
      if (groupSettings.antitag && !msg.key.fromMe) {
        const ctx = content.extendedTextMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];
        
        const messageText = (
          body ||
          content.imageMessage?.caption ||
          content.videoMessage?.caption ||
          ''
        );
        
        const textMentions = messageText.match(/@[\d+\s\-()~.]+/g) || [];
        const numericMentions = messageText.match(/@\d{10,}/g) || [];
        
        const uniqueNumericMentions = new Set();
        numericMentions.forEach((mention) => {
          const numMatch = mention.match(/@(\d+)/);
          if (numMatch) uniqueNumericMentions.add(numMatch[1]);
        });
        
        const mentionedJidCount = mentionedJids.length;
        const numericMentionCount = uniqueNumericMentions.size;
        const totalMentions = Math.max(mentionedJidCount, numericMentionCount);
        
        if (totalMentions >= 3) {
          try {
            const participants = groupMetadata.participants || [];
            const mentionThreshold = Math.max(3, Math.ceil(participants.length * 0.5));
            const hasManyNumericMentions = numericMentionCount >= 10 ||
              (numericMentionCount >= 5 && numericMentionCount >= mentionThreshold);
            
            if (totalMentions >= mentionThreshold || hasManyNumericMentions) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
              const senderIsOwner = isOwner(sender);
              
              if (!senderIsAdmin && !senderIsOwner) {
                const action = (groupSettings.antitagAction || 'delete').toLowerCase();
                
                if (action === 'delete') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                    await sock.sendMessage(from, { 
                      text: '⚠️ *Tagall Detected!*',
                      mentions: [sender]
                    }, { quoted: msg });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }
                } else if (action === 'kick') {
                  try {
                    await sock.sendMessage(from, { delete: msg.key });
                  } catch (e) {
                    console.error('Failed to delete tagall message:', e);
                  }
                  
                  const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
                  if (botIsAdmin) {
                    try {
                      await sock.groupParticipantsUpdate(from, [sender], 'remove');
                    } catch (e) {
                      console.error('Failed to kick for antitag:', e);
                    }
                    const usernames = [`@${sender.split('@')[0]}`];
                    await sock.sendMessage(from, {
                      text: `🚫 *Antitag Detected!*\n\n${usernames.join(', ')} has been kicked for tagging all members.`,
                      mentions: [sender],
                    }, { quoted: msg });
                  }
                }
                return;
              }
            }
          } catch (e) {
            console.error('Error during anti-tag enforcement:', e);
          }
        }
      }

      // Antibadword protection
      if (groupSettings.antibadword && !msg.key.fromMe) {
        const messageText = body || content.imageMessage?.caption || content.videoMessage?.caption || '';
        if (messageText) {
          try {
            const blocked = await handleAntibadword(sock, msg, groupMetadata, messageText, sender);
            if (blocked) return;
          } catch (e) {
            console.error('Error in antibadword handler:', e);
          }
        }
      }
    }
    
    // Anti-group mention protection (check BEFORE prefix check, as these are non-command messages)
    if (isGroup) {
      // Debug logging to confirm we're trying to call the handler
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      try {
        await handleAntigroupmention(sock, msg, groupMetadata);
      } catch (error) {
        console.error('Error in antigroupmention handler:', error);
      }
    }
    
    // AutoSticker feature - convert images/videos to stickers automatically
    if (isGroup) { // Process all messages in groups (including bot's own messages)
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.autosticker) {
        const mediaMessage = content?.imageMessage || content?.videoMessage;
        
        // Only process if it's an image or video (not documents)
        if (mediaMessage) {
          // Skip if message has a command prefix (let command handle it)
          if (!body.startsWith(config.prefix)) {
            try {
              // Import sticker command logic
              const stickerCmd = commands.get('sticker');
              if (stickerCmd) {
                // Execute sticker conversion silently
                await stickerCmd.execute(sock, msg, [], {
                  from,
                  sender,
                  isGroup,
                  groupMetadata,
                  isOwner: isOwner(sender),
                  isAdmin: await isAdmin(sock, sender, from, groupMetadata),
                  isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
                  isMod: isMod(sender),
                  reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
                  react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
                });
                return; // Don't process as command after auto-converting
              }
            } catch (error) {
              console.error('[AutoSticker Error]:', error);
              // Continue to normal processing if autosticker fails
            }
          }
        }
      }
    }

    // Bomb buttons and mid-game moves (1-9, cashout, suren) have no prefix
    if (!body.startsWith(config.prefix)) {
      try {
        const bombModule = require('./commands/fun/bomb');
        const inBomb = bombModule.gameState && bombModule.gameState.has(sender);
        const raw = (
          content?.buttonsResponseMessage?.selectedButtonId ||
          content?.buttonsResponseMessage?.selectedDisplayText ||
          content?.listResponseMessage?.singleSelectReply?.selectedRowId ||
          ''
        );
        const bombButton = /bombcfg|bombcell/i.test(String(raw));
        if (inBomb || bombButton) {
          await bombModule.execute(sock, msg, [], {
            from,
            sender,
            isGroup,
            groupMetadata,
            buttonHint: raw,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          return;
        }
      } catch (e) {
        // Bomb command missing or failed to load
      }
    }

    // Check for active tictactoe games (before prefix check)
    try {
      const tictactoeModule = require('./commands/fun/tictactoe');
      if (tictactoeModule.handleTicTacToeMove) {
        // Check if user is in an active game
        const isInGame = Object.values(tictactoeModule.games || {}).some(room => 
          room.id.startsWith('tictactoe') && 
          [room.game.playerX, room.game.playerO].includes(sender) && 
          room.state === 'PLAYING'
        );
        
        if (isInGame) {
          // User has active game, process input
          const handled = await tictactoeModule.handleTicTacToeMove(sock, msg, {
            from,
            sender,
            isGroup,
            groupMetadata,
            isOwner: isOwner(sender),
            isAdmin: await isAdmin(sock, sender, from, groupMetadata),
            isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
            isMod: isMod(sender),
            reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
            react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
          });
          if (handled) return; // Don't process as command if move was handled
        }
      }
    } catch (e) {
      // Silently ignore if tictactoe command doesn't exist or has errors
    }

    try {
      const { handleGameInput } = require('./utils/funGames');
      const handled = await handleGameInput(sock, msg, {
        from,
        sender,
        isGroup,
        groupMetadata,
        isOwner: isOwner(sender),
        reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
      });
      if (handled) return;
    } catch (e) {
      // ignore fun game handler errors
    }

    // AFK — one-time reply when owner is away (groups + DMs)
    if (!msg.key.fromMe) {
      const afk = require('./utils/afk');
      if (afk.isEnabled() && !isOwner(sender)) {
        let shouldHandleAfk = false;

        if (!isGroup) {
          // DM: any message from non-owner triggers AFK once
          shouldHandleAfk = true;
        } else {
          const ctx = content.extendedTextMessage?.contextInfo
            || content.imageMessage?.contextInfo
            || content.videoMessage?.contextInfo
            || content.stickerMessage?.contextInfo;
          const mentionedJids = ctx?.mentionedJid || [];
          const isMentioned = mentionedJids.some(jid => isBotJid(jid, sock));
          const isReplyToBot = ctx?.participant && isBotJid(ctx.participant, sock);
          shouldHandleAfk = (isMentioned || isReplyToBot) && !body.startsWith(config.prefix);
        }

        if (shouldHandleAfk) {
          if (afk.shouldNotify(from, sender)) {
            afk.markNotified(from, sender);
            await sock.sendMessage(from, { text: afk.getMessage() }, { quoted: msg });
          }
          return;
        }
      }
    }

    // Chatbot — respond when bot is @mentioned or user replies to bot
    if (!msg.key.fromMe && isGroup) {
      const groupSettings = database.getGroupSettings(from);
      if (groupSettings.chatbot) {
        const ctx = content?.extendedTextMessage?.contextInfo
          || content?.imageMessage?.contextInfo
          || content?.videoMessage?.contextInfo
          || content?.documentMessage?.contextInfo;
        const mentionedJids = ctx?.mentionedJid || [];
        const isMentioned = mentionedJids.some(jid => isBotJid(jid, sock));
        const isReplyToBot = ctx?.participant && isBotJid(ctx.participant, sock);

        if ((isMentioned || isReplyToBot) && !body.startsWith(config.prefix)) {
          if (groupSettings.suppress) {
            const staff = isOwner(sender) || await isAdmin(sock, sender, from, groupMetadata);
            if (!staff) return;
          }
          await chatbotCmd.handleChat(sock, msg, body, sender);
          return;
        }
      }
    }

    // Check if message starts with prefix
    if (!body.startsWith(config.prefix)) return;
    
    // Parse command
    const args = body.slice(config.prefix.length).trim().split(/\s+/);
    const commandName = args.shift().toLowerCase();
    
    // Get command
    const command = commands.get(commandName);
    if (!command) return;
    
    // Suppressed group: members get no reply. Owner and group admins still can.
    if (isGroup && database.getGroupSettings(from).suppress) {
      const staff = isOwner(sender) || await isAdmin(sock, sender, from, groupMetadata);
      if (!staff) return;
    }

    // Check self mode (private mode) - only owner can use commands
    if (config.selfMode && !isOwner(sender)) {
      return;
    }
    
    // Permission checks
    if (command.ownerOnly && !isOwner(sender)) {
      return sock.sendMessage(from, { text: config.messages.ownerOnly }, { quoted: msg });
    }
    
    if (command.modOnly && !isMod(sender) && !isOwner(sender)) {
      return sock.sendMessage(from, { text: '🔒 This command is only for moderators!' }, { quoted: msg });
    }
    
    if (command.groupOnly && !isGroup) {
      return sock.sendMessage(from, { text: config.messages.groupOnly }, { quoted: msg });
    }
    
    if (command.privateOnly && isGroup) {
      return sock.sendMessage(from, { text: config.messages.privateOnly }, { quoted: msg });
    }
    
    if (command.adminOnly && !(await isAdmin(sock, sender, from, groupMetadata)) && !isOwner(sender)) {
      return sock.sendMessage(from, { text: config.messages.adminOnly }, { quoted: msg });
    }
    
    if (command.botAdminNeeded) {
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      if (!botIsAdmin) {
        return sock.sendMessage(from, { text: config.messages.botAdminNeeded }, { quoted: msg });
      }
    }
    
    // Auto-typing
    if (config.autoTyping) {
      await sock.sendPresenceUpdate('composing', from);
    }
    
    // Execute command
    console.log(`Executing command: ${commandName} from ${sender}`);
    
    await command.execute(sock, msg, args, {
      from,
      sender,
      isGroup,
      groupMetadata,
      pushName: msg.pushName,
      commandName,
      isOwner: isOwner(sender),
      isAdmin: await isAdmin(sock, sender, from, groupMetadata),
      isBotAdmin: await isBotAdmin(sock, from, groupMetadata),
      isMod: isMod(sender),
      reply: (text) => sock.sendMessage(from, { text }, { quoted: msg }),
      react: (emoji) => sock.sendMessage(from, { react: { text: emoji, key: msg.key } })
    });
    
  } catch (error) {
    console.error('Error in message handler:', error);
    
    // Don't send error messages for rate limit errors
    if (error.message && error.message.includes('rate-overlimit')) {
      console.warn('⚠️ Rate limit reached. Skipping error message.');
      return;
    }
    
    try {
      await sock.sendMessage(msg.key.remoteJid, { 
        text: `${config.messages.error}\n\n${error.message}` 
      }, { quoted: msg });
    } catch (e) {
      // Don't log rate limit errors when sending error messages
      if (!e.message || !e.message.includes('rate-overlimit')) {
        console.error('Error sending error message:', e);
      }
    }
  }
};

function fillJoinTemplate(template, { user, group, count, time, desc, botName }) {
  return String(template || '')
    .replaceAll('@user', user || '')
    .replaceAll('@group', group || '')
    .replaceAll('#memberCount', String(count ?? ''))
    .replaceAll('groupDesc', desc || '')
    .replaceAll('botName', botName || '')
    .replaceAll('time', time || '');
}

// Group participant update handler
const handleGroupUpdate = async (sock, update) => {
  try {
    const { id, participants, action } = update;
    
    // Validate group JID before processing
    if (!id || !id.endsWith('@g.us')) {
      return;
    }
    if (!isSocketOpen(sock)) return;
    if (sock.groupAlertsReadyAt && Date.now() < sock.groupAlertsReadyAt) return;
    
    const groupSettings = database.getGroupSettings(id);
    
    if (!groupSettings.welcome && !groupSettings.goodbye) return;

    groupMetadataCache.delete(id);
    const groupMetadata = await getLiveGroupMetadata(sock, id);
    if (!groupMetadata) return; // Skip if metadata unavailable (forbidden or error)
    if (!isSocketOpen(sock)) return;
    
    // Helper to extract participant JID
    const getParticipantJid = (participant) => {
      if (typeof participant === 'string') {
        return participant;
      }
      if (participant && participant.id) {
        return participant.id;
      }
      if (participant && typeof participant === 'object') {
        // Try to find JID in object
        return participant.jid || participant.participant || null;
      }
      return null;
    };
    
    for (const participant of participants) {
      const participantJid = getParticipantJid(participant);
      if (!participantJid) {
        console.warn('Could not extract participant JID:', participant);
        continue;
      }
      
      rememberContact(participant);
      const participantNumber = participantJid.split('@')[0];
      if (isBotJid(participantJid, sock)) continue;
      // One join can arrive as both a phone JID and a LID; treat every form as the same person.
      const p = typeof participant === 'object' && participant ? participant : {};
      const personKeys = [...new Set(
        [participantJid, p.id, p.lid, p.phoneNumber, p.jid]
          .filter(Boolean)
          .flatMap((jid) => [jid, ...buildComparableIds(jid)])
          .map((jid) => `${id}:${action}:${String(jid).split('@')[0].split(':')[0]}`)
      )];
      const now = Date.now();
      if (personKeys.some((key) => now - (recentJoinLeaveCards.get(key) || 0) < 45000)) continue;
      if (recentJoinLeaveCards.size > 500) {
        for (const [key, at] of recentJoinLeaveCards) {
          if (now - at > 45000) recentJoinLeaveCards.delete(key);
        }
      }
      for (const key of personKeys) recentJoinLeaveCards.set(key, now);
      
      if (action === 'add' && groupSettings.welcome) {
        try {
          const target = await resolveJoinLeaveTarget(sock, participant, participantJid, groupMetadata);
          if (!isSocketOpen(sock)) return;
          const displayName = target.displayName;
          const profilePicUrl = target.profilePicUrl;
          
          // Get group name and description
          const groupName = groupMetadata.subject || 'the group';
          const groupDesc = String(groupMetadata.desc || 'No description').slice(0, 400);
          const timeString = new Date().toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: true
          });
          const welcomeMsg = fillJoinTemplate(groupSettings.welcomeMessage, {
            user: target.mentionText,
            group: groupName,
            count: groupMetadata.participants.length,
            time: timeString,
            desc: groupDesc,
            botName: config.botName,
          });
          
          const imageBuffer = await APIs.getCardImage('welcome', {
            name: displayName,
            group: groupName,
            count: String(groupMetadata.participants.length),
            pic: profilePicUrl,
            theme: 'comic',
          });
          
          await sendGroupCard(sock, id, {
            image: imageBuffer,
            caption: welcomeMsg,
            mentions: target.mentions,
          }, groupMetadata);
        } catch (welcomeError) {
          console.error('Welcome image error:', welcomeError);
          if (isTransientGroupError(welcomeError)) return;
          const who = toMention(participantJid);
          const message = fillJoinTemplate(
            groupSettings.welcomeMessage || 'Welcome @user to @group! 👋\nEnjoy your stay!',
            {
              user: who.text || `@${participantNumber}`,
              group: groupMetadata.subject || 'the group',
              count: groupMetadata.participants?.length || '',
              time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
              desc: String(groupMetadata.desc || 'No description').slice(0, 400),
              botName: config.botName,
            }
          );
          try {
            await sendGroupCard(sock, id, {
              text: message,
              mentions: who.mentions.length ? who.mentions : [participantJid],
            }, groupMetadata);
          } catch (fallbackError) {
            if (!isTransientGroupError(fallbackError)) throw fallbackError;
          }
        }
      } else if (action === 'remove' && groupSettings.goodbye) {
        try {
          const target = await resolveJoinLeaveTarget(sock, participant, participantJid, groupMetadata);
          const displayName = target.displayName;
          const profilePicUrl = target.profilePicUrl;
          const groupName = groupMetadata.subject || 'the group';
          const goodbyeMsg = fillJoinTemplate(
            groupSettings.goodbyeMessage || 'Goodbye @user 👋 We will never miss you!',
            {
              user: target.mentionText,
              group: groupName,
              count: groupMetadata.participants.length,
              time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
              desc: String(groupMetadata.desc || '').slice(0, 400),
              botName: config.botName,
            }
          );
          
          const imageBuffer = await APIs.getCardImage('goodbye', {
            name: displayName,
            group: groupName,
            count: String(groupMetadata.participants.length),
            pic: profilePicUrl,
            theme: 'comic',
          });
          
          await sendGroupCard(sock, id, {
            image: imageBuffer,
            caption: goodbyeMsg,
            mentions: target.mentions,
          }, groupMetadata);
        } catch (goodbyeError) {
          console.error('Goodbye error:', goodbyeError);
          if (isTransientGroupError(goodbyeError)) return;
          const who = toMention(participantJid);
          const goodbyeMsg = fillJoinTemplate(
            groupSettings.goodbyeMessage || 'Goodbye @user 👋 We will never miss you!',
            {
              user: who.text || `@${participantNumber}`,
              group: groupMetadata.subject || 'the group',
              count: groupMetadata.participants?.length || '',
              time: new Date().toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true }),
              desc: String(groupMetadata.desc || '').slice(0, 400),
              botName: config.botName,
            }
          );
          try {
            await sendGroupCard(sock, id, {
              text: goodbyeMsg,
              mentions: who.mentions.length ? who.mentions : [participantJid],
            }, groupMetadata);
          } catch (fallbackError) {
            if (!isTransientGroupError(fallbackError)) throw fallbackError;
          }
        }
      }
    }
  } catch (error) {
    // Silently handle forbidden errors and other group metadata errors
    if (error.message && (
      error.message.includes('forbidden') || 
      error.message.includes('403') ||
      error.statusCode === 403 ||
      error.output?.statusCode === 403 ||
      error.data === 403
    )) {
      // Silently skip forbidden groups
      return;
    }
    // Only log non-forbidden errors
    if (!error.message || !error.message.includes('forbidden')) {
      console.error('Error handling group update:', error);
    }
  }
};

// Detect WhatsApp group status posts (groupStatusMessage / groupStatusMessageV2)
const isGroupStatusPost = (msg, content) => {
  const unwrapped = content || getMessageContent(msg);
  return !!(
    unwrapped?.groupStatusMessage ||
    unwrapped?.groupStatusMessageV2 ||
    msg.message?.groupStatusMessage ||
    msg.message?.groupStatusMessageV2
  );
};

// Anti-group status handler
const handleAntigroupstatus = async (sock, msg, groupMetadata, content) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antigroupstatus) return false;
    if (!isGroupStatusPost(msg, content)) return false;

    // TESTING: admins/owners not exempt — remove this block later
    // const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    // const senderIsOwner = isOwner(sender);
    // if (senderIsAdmin || senderIsOwner) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    const action = (groupSettings.antigroupstatusAction || 'delete').toLowerCase();

    let deleted = false;
    try {
      deleted = sock.revokeGroupStatus
        ? await sock.revokeGroupStatus(from, msg)
        : false;
      if (deleted) groupStatusTracker.remove(from, [msg.key.id]);
    } catch (e) {
      console.error('Failed to delete group status post:', e.message);
    }

    if (!deleted && action !== 'kick') return true;

    if (action === 'kick' && botIsAdmin) {
      try {
        await sock.groupParticipantsUpdate(from, [sender], 'remove');
        await sock.sendMessage(from, {
          text: '📵 *Anti Group Status!* @user was kicked for posting a group status.',
          mentions: [sender]
        }, { quoted: msg });
      } catch (e) {
        console.error('Failed to kick for antigroupstatus:', e);
      }
    } else if (deleted) {
      try {
        await sock.sendMessage(from, {
          text: '📵 *Anti Group Status!* Group status removed.',
          mentions: [sender]
        }, { quoted: msg });
      } catch (e) {
        console.error('Failed to notify antigroupstatus:', e);
      }
    }

    return true;
  } catch (error) {
    console.error('Error in antigroupstatus handler:', error);
    return false;
  }
};

// Antibot — detect other bots via Baileys-style message IDs (BAE5 / 3EB0)
const BOT_MSG_ID_RE = /^(BAE5|3EB0)/i;

function isBotLikeMessageId(id) {
  return typeof id === 'string' && BOT_MSG_ID_RE.test(id);
}

const handleAntibot = async (sock, msg, groupMetadata, sender) => {
  try {
    const from = msg.key.remoteJid;
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antibot) return false;

    const msgId = msg.key?.id;
    if (!isBotLikeMessageId(msgId)) return false;

    // Ignore protocol / empty envelopes
    const unwrapped = getMessageContent(msg);
    if (!unwrapped) return false;
    const keys = Object.keys(unwrapped).filter(
      (k) => !['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(k)
    );
    if (!keys.length) return false;

    const who = sender || msg.key.participant || msg.key.remoteJid;
    if (isBotJid(who, sock)) return false;

    const senderIsAdmin = await isAdmin(sock, who, from, groupMetadata);
    const senderIsOwner = isOwner(who);
    if (senderIsAdmin || senderIsOwner) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    if (!botIsAdmin) {
      console.warn('[antibot] bot is not admin — cannot enforce');
      return false;
    }

    const action = (groupSettings.antibotAction || 'warn').toLowerCase();
    console.log(`[antibot] hit id=${msgId} sender=${who} action=${action}`);

    try {
      await sock.sendMessage(from, { delete: msg.key });
    } catch (e) {
      console.error('[antibot] delete failed:', e.message);
    }

    const maxWarnings = config.maxWarnings || 3;

    if (action === 'kick') {
      try {
        await sock.groupParticipantsUpdate(from, [who], 'remove');
        await sock.sendMessage(from, {
          text: `🤖 *Antibot!* @${who.split('@')[0]} was kicked (bot activity detected).`,
          mentions: [who],
        });
      } catch (e) {
        console.error('[antibot] kick failed:', e.message);
      }
    } else {
      // warn (default)
      const result = database.addWarning(from, who, 'Bot activity');
      if (result.count >= maxWarnings) {
        try {
          await sock.groupParticipantsUpdate(from, [who], 'remove');
          database.clearWarnings(from, who);
          await sock.sendMessage(from, {
            text: `🤖 *Antibot!* @${who.split('@')[0]} was kicked after ${maxWarnings} bot warnings.`,
            mentions: [who],
          });
        } catch (e) {
          console.error('[antibot] kick after warn failed:', e.message);
        }
      } else {
        await sock.sendMessage(from, {
          text: `⚠️ *Antibot!* @${who.split('@')[0]} warning ${result.count}/${maxWarnings} — bot activity detected.`,
          mentions: [who],
        });
      }
    }

    return true;
  } catch (error) {
    console.error('Error in antibot handler:', error);
    return false;
  }
};

// Antispam — 5 messages in 8s, or the same text 3 times in a row
const SPAM_WINDOW_MS = 8000;
const SPAM_MAX = 5;
const SPAM_REPEAT = 3;
const SPAM_COOLDOWN_MS = 15000;
const spamBuckets = new Map();
const spamCooldown = new Map();

function spamTextOf(content) {
  if (!content) return '';
  const text =
    content.conversation ||
    content.extendedTextMessage?.text ||
    content.imageMessage?.caption ||
    content.videoMessage?.caption ||
    '';
  return String(text).trim().toLowerCase();
}

function noteSpam(group, sender, text) {
  const key = `${group}|${sender}`;
  const now = Date.now();
  const list = (spamBuckets.get(key) || []).filter((row) => now - row.t < SPAM_WINDOW_MS);
  list.push({ t: now, text });
  spamBuckets.set(key, list);
  const burst = list.length >= SPAM_MAX;
  const tail = list.slice(-SPAM_REPEAT);
  const repeat = !!text && tail.length >= SPAM_REPEAT && tail.every((row) => row.text === text);
  return { key, hit: burst || repeat };
}

const handleAntispam = async (sock, msg, groupMetadata, sender, content) => {
  try {
    const from = msg.key.remoteJid;
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antiSpam) return false;

    const unwrapped = content || getMessageContent(msg);
    if (!unwrapped) return false;
    const keys = Object.keys(unwrapped).filter(
      (k) => !['protocolMessage', 'senderKeyDistributionMessage', 'messageContextInfo'].includes(k)
    );
    if (!keys.length) return false;

    const who = sender || msg.key.participant || msg.key.remoteJid;
    if (isBotJid(who, sock)) return false;

    const senderIsAdmin = await isAdmin(sock, who, from, groupMetadata);
    const senderIsOwner = isOwner(who);
    if (senderIsAdmin || senderIsOwner) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    if (!botIsAdmin) {
      console.warn('[antispam] bot is not admin — cannot enforce');
      return false;
    }

    const { key, hit } = noteSpam(from, who, spamTextOf(unwrapped));
    if (!hit) return false;

    try {
      await sock.sendMessage(from, { delete: msg.key });
    } catch (e) {
      console.error('[antispam] delete failed:', e.message);
    }

    const now = Date.now();
    if ((spamCooldown.get(key) || 0) > now) return true;
    spamCooldown.set(key, now + SPAM_COOLDOWN_MS);

    const action = (groupSettings.antiSpamAction || 'warn').toLowerCase();
    const maxWarnings = config.maxWarnings || 3;
    console.log(`[antispam] hit sender=${who} action=${action}`);

    if (action === 'kick') {
      spamBuckets.delete(key);
      try {
        await sock.groupParticipantsUpdate(from, [who], 'remove');
        await sock.sendMessage(from, {
          text: `🚫 *Antispam!* @${who.split('@')[0]} was kicked (message burst).`,
          mentions: [who],
        });
      } catch (e) {
        console.error('[antispam] kick failed:', e.message);
      }
    } else {
      const result = database.addWarning(from, who, 'Spam');
      if (result.count >= maxWarnings) {
        spamBuckets.delete(key);
        try {
          await sock.groupParticipantsUpdate(from, [who], 'remove');
          database.clearWarnings(from, who);
          await sock.sendMessage(from, {
            text: `🚫 *Antispam!* @${who.split('@')[0]} was kicked after ${maxWarnings} spam warnings.`,
            mentions: [who],
          });
        } catch (e) {
          console.error('[antispam] kick after warn failed:', e.message);
        }
      } else {
        await sock.sendMessage(from, {
          text: `⚠️ *Antispam!* @${who.split('@')[0]} warning ${result.count}/${maxWarnings} — slow down.`,
          mentions: [who],
        });
      }
    }

    return true;
  } catch (error) {
    console.error('Error in antispam handler:', error);
    return false;
  }
};

// Antibadword handler
const handleAntibadword = async (sock, msg, groupMetadata, userMessage, sender) => {
  try {
    const from = msg.key.remoteJid;
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antibadword) return false;
    if (!containsBadWord(userMessage)) return false;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    const senderIsOwner = isOwner(sender);
    if (senderIsAdmin || senderIsOwner) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    if (!botIsAdmin) return false;

    try {
      await sock.sendMessage(from, { delete: msg.key });
    } catch (e) {
      console.error('Failed to delete badword message:', e);
      return false;
    }

    const action = (groupSettings.antibadwordAction || 'delete').toLowerCase();
    const maxWarnings = config.maxWarnings || 3;

    if (action === 'kick') {
      try {
        await sock.groupParticipantsUpdate(from, [sender], 'remove');
        await sock.sendMessage(from, {
          text: '🚫 *Antibadword!* @user was kicked for using bad words.',
          mentions: [sender],
        }, { quoted: msg });
      } catch (e) {
        console.error('Failed to kick for antibadword:', e);
      }
    } else if (action === 'warn') {
      const result = database.addWarning(from, sender, 'Bad words');
      if (result.count >= maxWarnings) {
        try {
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          database.clearWarnings(from, sender);
          await sock.sendMessage(from, {
            text: `🚫 *Antibadword!* @user was kicked after ${maxWarnings} warnings.`,
            mentions: [sender],
          }, { quoted: msg });
        } catch (e) {
          console.error('Failed to kick after antibadword warnings:', e);
        }
      } else {
        await sock.sendMessage(from, {
          text: `⚠️ *Antibadword!* @user warning ${result.count}/${maxWarnings} for bad words.`,
          mentions: [sender],
        }, { quoted: msg });
      }
    } else {
      const sticker = await getAntibadwordSticker();
      if (sticker) {
        await sock.sendMessage(from, { sticker }, { quoted: msg });
      }
    }

    return true;
  } catch (error) {
    console.error('Error in antibadword handler:', error);
    return false;
  }
};

// Antisticker handler
const handleAntisticker = async (sock, msg, groupMetadata, content) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;

    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antisticker) return false;

    const unwrapped = content || getMessageContent(msg);
    const isSticker = !!(unwrapped?.stickerMessage || msg.message?.stickerMessage);
    if (!isSticker) return false;

    const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
    const senderIsOwner = isOwner(sender);
    if (senderIsAdmin || senderIsOwner) return false;

    const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
    const action = (groupSettings.antistickerAction || 'delete').toLowerCase();

    try {
      await sock.sendMessage(from, { delete: msg.key });
    } catch (e) {
      console.error('Failed to delete sticker for antisticker:', e);
    }

    if (action === 'kick' && botIsAdmin) {
      try {
        await sock.groupParticipantsUpdate(from, [sender], 'remove');
      } catch (e) {
        console.error('Failed to kick for antisticker:', e);
      }
    }

    return true;
  } catch (error) {
    console.error('Error in antisticker handler:', error);
    return false;
  }
};

// Antilink handler
const handleAntilink = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    if (!groupSettings.antilink) return;
    
    if (msgHasLink(msg)) {
              const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = isOwner(sender);
      
      if (senderIsAdmin || senderIsOwner) return;
      
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      const action = (groupSettings.antilinkAction || 'delete').toLowerCase();
      
      if (action === 'kick' && botIsAdmin) {
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          await sock.sendMessage(from, { 
            text: `🔗 Anti-link triggered. Link removed.`,
            mentions: [sender]
          }, { quoted: msg });
        } catch (e) {
          console.error('Failed to kick for antilink:', e);
        }
      } else {
        // Default: delete message
        try {
          await sock.sendMessage(from, { delete: msg.key });
          await sock.sendMessage(from, { 
            text: `🔗 Anti-link triggered. Link removed.`,
            mentions: [sender]
          }, { quoted: msg });
        } catch (e) {
          console.error('Failed to delete message for antilink:', e);
        }
      }
    }
  } catch (error) {
    console.error('Error in antilink handler:', error);
  }
};


// Anti-group mention handler
const handleAntigroupmention = async (sock, msg, groupMetadata) => {
  try {
    const from = msg.key.remoteJid;
    const sender = msg.key.participant || msg.key.remoteJid;
    
    const groupSettings = database.getGroupSettings(from);
    
    // Debug logging to confirm handler is being called
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Log simplified message info instead of full structure to avoid huge logs
      // Debug log removed
    }
    
    if (!groupSettings.antigroupmention) return;
    
    // Check if this is a forwarded status message that mentions the group
    // Comprehensive detection for various status mention message types
    let isForwardedStatus = false;
    
    if (msg.message) {
      // Direct checks for known status mention message types
      isForwardedStatus = isForwardedStatus || !!msg.message.groupStatusMentionMessage;
      isForwardedStatus = isForwardedStatus || 
        (msg.message.protocolMessage && msg.message.protocolMessage.type === 25); // STATUS_MENTION_MESSAGE
      
      // Check for forwarded newsletter info in various message types
      isForwardedStatus = isForwardedStatus || 
        (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo && 
         msg.message.extendedTextMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.conversation && msg.message.contextInfo && 
         msg.message.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.imageMessage && msg.message.imageMessage.contextInfo && 
         msg.message.imageMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.videoMessage && msg.message.videoMessage.contextInfo && 
         msg.message.videoMessage.contextInfo.forwardedNewsletterMessageInfo);
      isForwardedStatus = isForwardedStatus || 
        (msg.message.contextInfo && msg.message.contextInfo.forwardedNewsletterMessageInfo);
      
      // Generic check for any forwarded message
      if (msg.message.contextInfo) {
        const ctx = msg.message.contextInfo;
        isForwardedStatus = isForwardedStatus || !!ctx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!ctx.forwardingScore;
        // Additional check for forwarded status specifically
        isForwardedStatus = isForwardedStatus || !!ctx.quotedMessageTimestamp;
      }
      
      // Additional checks for forwarded messages
      if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
        const extCtx = msg.message.extendedTextMessage.contextInfo;
        isForwardedStatus = isForwardedStatus || !!extCtx.isForwarded;
        isForwardedStatus = isForwardedStatus || !!extCtx.forwardingScore;
      }
    }
    
    // Additional debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    // Additional debug logging to help identify message structure
    if (groupSettings.antigroupmention) {
      // Debug log removed
      // Debug log removed
      if (msg.message) {
        // Debug log removed
        // Log specific message types that might indicate a forwarded status
        if (msg.message.protocolMessage) {
          // Debug log removed
        }
        if (msg.message.contextInfo) {
          // Debug log removed
        }
        if (msg.message.extendedTextMessage && msg.message.extendedTextMessage.contextInfo) {
          // Debug log removed
        }
      }
    }
    
    // Debug logging for detection
    if (groupSettings.antigroupmention) {
      // Debug log removed
    }
    
    if (isForwardedStatus) {
      if (groupSettings.antigroupmention) {
        // Process forwarded status message
      }
      
      const senderIsAdmin = await isAdmin(sock, sender, from, groupMetadata);
      const senderIsOwner = isOwner(sender);
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      // Don't act on admins or owners
      if (senderIsAdmin || senderIsOwner) return;
      
      const botIsAdmin = await isBotAdmin(sock, from, groupMetadata);
      const action = (groupSettings.antigroupmentionAction || 'delete').toLowerCase();
      
      if (groupSettings.antigroupmention) {
        // Debug log removed
      }
      
      if (action === 'kick' && botIsAdmin) {
        try {
          if (groupSettings.antigroupmention) {
            // Delete and kick user
          }
          await sock.sendMessage(from, { delete: msg.key });
          await sock.groupParticipantsUpdate(from, [sender], 'remove');
          // Silent removal
        } catch (e) {
          console.error('Failed to kick for antigroupmention:', e);
        }
      } else {
        // Default: delete message
        try {
          if (groupSettings.antigroupmention) {
            // Delete message
          }
          await sock.sendMessage(from, { delete: msg.key });
          // Silent deletion
        } catch (e) {
          console.error('Failed to delete message for antigroupmention:', e);
        }
      }
    } else if (groupSettings.antigroupmention) {
      // Debug log removed
    }
  } catch (error) {
    console.error('Error in antigroupmention handler:', error);
  }
};


// Anti-call feature initializer
const initializeAntiCall = (sock) => {
  // Anti-call feature - reject and block incoming calls
  sock.ev.on('call', async (calls) => {
    try {
      // Reload config to get fresh settings
      delete require.cache[require.resolve('./config')];
      const config = require('./config');
      
      if (!config.defaultGroupSettings.anticall) return;

      for (const call of calls) {
        if (call.status === 'offer') {
          // Reject the call
          await sock.rejectCall(call.id, call.from);

          // Block the caller
          await sock.updateBlockStatus(call.from, 'block');

          // Notify user
          await sock.sendMessage(call.from, {
            text: '🚫 Calls are not allowed. You have been blocked.'
          });
        }
      }
    } catch (err) {
      console.error('[ANTICALL ERROR]', err);
    }
  });
};

module.exports = {
  handleMessage,
  handleGroupUpdate,
  handleAntilink,
  handleAntibadword,
  handleAntisticker,
  handleAntibot,
  handleAntispam,
  handleAntigroupstatus,
  handleAntigroupmention,
  initializeAntiCall,
  isOwner,
  isAdmin,
  isBotAdmin,
  isMod,
  isBotLikeMessageId,
  getGroupMetadata,
  peekGroupMetadata,
  findParticipant
};
const { generateMessageID } = require('@whiskeysockets/baileys');

const ACK_WAIT_MS = 5000;
const MAX_ROUNDS = 3;
const GAP_MS = 1000;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const metaNode = () => ({ tag: 'meta', attrs: { is_group_status: 'true' } });

function createStatusRevoker(sock) {
  const acks = new Map();
  const handled = new Set();
  let queue = Promise.resolve();

  sock.ws.on('CB:ack,class:message', (node) => {
    const id = node?.attrs?.id;
    if (!id) return;
    acks.set(id, node.attrs);
    if (acks.size > 500) acks.delete(acks.keys().next().value);
  });

  async function waitAck(id) {
    const end = Date.now() + ACK_WAIT_MS;
    while (Date.now() < end) {
      const ack = acks.get(id);
      if (ack) return ack;
      await sleep(100);
    }
    return null;
  }

  function authorKey(remoteJid, msg) {
    return {
      remoteJid,
      fromMe: !!msg.key.fromMe,
      id: msg.key.id,
      participant: msg.key.participant || msg.participant,
    };
  }

  async function sendWrapped(remoteJid, msg) {
    const messageId = generateMessageID();
    await sock.relayMessage(
      remoteJid,
      {
        groupStatusMessageV2: {
          message: { protocolMessage: { key: authorKey(remoteJid, msg), type: 0 } },
        },
      },
      { messageId, additionalAttributes: { edit: '8' }, additionalNodes: [metaNode()] }
    );
    return messageId;
  }

  async function sendPlain(remoteJid, msg) {
    const sent = await sock.sendMessage(remoteJid, { delete: authorKey(remoteJid, msg) });
    return sent?.key?.id;
  }

  async function acked(ids) {
    for (const id of ids.filter(Boolean)) {
      const ack = await waitAck(id);
      if (!ack || ack.error) return false;
    }
    return ids.filter(Boolean).length > 0;
  }

  async function run(remoteJid, msg) {
    const statusId = msg?.key?.id;
    if (!statusId) return false;
    if (handled.has(statusId)) return true;
    handled.add(statusId);
    if (handled.size > 1000) handled.delete(handled.values().next().value);

    const attempts = [
      async () => {
        const wrapped = await sendWrapped(remoteJid, msg);
        await sleep(GAP_MS);
        return [wrapped, await sendPlain(remoteJid, msg)];
      },
      async () => [await sendWrapped(remoteJid, msg)],
      async () => [await sendPlain(remoteJid, msg)],
    ];

    for (let round = 1; round <= MAX_ROUNDS; round++) {
      for (const send of attempts) {
        try {
          if (await acked(await send())) return true;
        } catch (_) {}
      }
      await sleep(1000 * round);
    }

    handled.delete(statusId);
    console.log(`[antigroupstatus] could not delete ${statusId}`);
    return false;
  }

  return function revokeStatus(remoteJid, msg) {
    const job = queue.then(() => run(remoteJid, msg));
    queue = job.catch(() => {});
    return job;
  };
}

module.exports = { createStatusRevoker };

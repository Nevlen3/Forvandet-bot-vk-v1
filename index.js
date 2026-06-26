

import dotenv from 'dotenv';
dotenv.config();
import express from 'express';
import bodyParser from 'body-parser';
import { VK } from 'vk-io';
import fs from 'fs';

const app = express();
app.use(bodyParser.json());

const vk = new VK({ token: process.env.USER_TOKEN });


app.post('/callback', async (req, res) => {
  console.log('📩 CALLBACK:', req.body.type);
  const data = req.body;

  // подтверждение сервера
  if (data.type === 'confirmation') {
    return res.send(process.env.CONFIRMATION);
  }

  // предложена запись
  if (data.type === 'wall_post_new') {
    const post = data.object;
    if (!post || !post.id) return res.send('ok');

    try {
      const full = await vk.api.wall.getById({
        posts: `-${Number(process.env.GROUP_ID)}_${post.id}`
      });

      if (!full?.[0]) return res.send('ok');

      const p = full[0];

      const attachments = (p.attachments || [])
        .slice(0, 10)
        .map(a => `${a.type}${a.owner_id}_${a.id}`);

      const text = `
📨 Новая предложка

${p.text || ''}

🔗 https://vk.com/wall-${Math.abs(p.owner_id)}_${p.id}
      `.trim();

      await vk.api.messages.send({
        peer_id: Number(process.env.PEER_ID),
        random_id: Date.now(),
        message: text,
        attachment: attachments.join(',')
      });

      console.log('✔ переслано', p.id);
    } catch (e) {
      console.error('Ошибка:', e.message);
    }
  }

  res.send('ok');
});

app.listen(3000, () => {
  console.log('🚀 Callback сервер запущен на :3000');
});


// ====== ПЕРИОДИЧЕСКАЯ ПРОВЕРКА ПРЕДЛОЖКИ ======


const LAST_ID_FILE = 'last_id.txt';
let lastCheckedId = 0;
try {
  if (fs.existsSync(LAST_ID_FILE)) {
    lastCheckedId = Number(fs.readFileSync(LAST_ID_FILE, 'utf8')) || 0;
  } else {
    // Если файла нет — берём максимальный id из предложки (только при первом запуске)
    (async () => {
      try {
        const res = await vk.api.wall.get({
          owner_id: -Number(process.env.GROUP_ID),
          filter: 'suggests',
          count: 10
        });
        if (res.items && res.items.length) {
          lastCheckedId = Math.max(...res.items.map(p => p.id));
          fs.writeFileSync(LAST_ID_FILE, String(lastCheckedId));
        }
      } catch (e) {
        console.error('Ошибка инициализации last_id.txt:', e.message);
      }
    })();
  }
} catch (e) {
  console.error('Ошибка чтения last_id.txt:', e.message);
}

async function checkSuggests() {
  try {
    const res = await vk.api.wall.get({
      owner_id: -Number(process.env.GROUP_ID),
      filter: 'suggests',
      count: 10
    });
    if (!res.items || !res.items.length) return;

    // Сортируем по id по возрастанию (от старых к новым)
    const sorted = res.items.slice().sort((a, b) => a.id - b.id);
    // Отбираем только новые посты
    const newPosts = sorted.filter(post => post.id > lastCheckedId);
    if (!newPosts.length) return;

    let maxId = lastCheckedId;
    // Функция задержки
    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
    // Защита от повторной отправки id за запуск
    const sentIds = new Set();
    for (const post of newPosts) {
      if (sentIds.has(post.id)) continue;
      sentIds.add(post.id);
      // attachments: только фото и документы
      const attachments = (post.attachments || [])
        .filter(a => a.type === 'photo' || a.type === 'doc')
        .slice(0, 10)
        .map(a => {
          if (a.type === 'photo') return `photo${a.photo.owner_id}_${a.photo.id}`;
          if (a.type === 'doc') return `doc${a.doc.owner_id}_${a.doc.id}`;
        })
        .filter(Boolean);

      // Получаем имя и фамилию автора
      let authorName = '';
      let authorLink = '';
      if (post.from_id > 0) {
        // Пользователь
        const user = await vk.api.users.get({ user_ids: post.from_id });
        if (user && user[0]) {
          authorName = `${user[0].first_name} ${user[0].last_name}`;
          authorLink = `https://vk.com/id${post.from_id}`;
        }
      } else {
        // Сообщество
        const group = await vk.api.groups.getById({ group_id: Math.abs(post.from_id) });
        if (group && group[0]) {
          authorName = group[0].name;
          authorLink = `https://vk.com/club${Math.abs(post.from_id)}`;
        }
      }

      const postLink = `https://vk.com/wall-${Math.abs(post.owner_id)}_${post.id}`;
      const text = `\n${post.text || ''}\n\n👤 ${authorName} (${authorLink})\n🔗 Пост: ${postLink}`.trim();

      try {
        await vk.api.messages.send({
          peer_id: Number(process.env.PEER_ID),
          random_id: Date.now(),
          message: text,
          attachment: attachments.join(',')
        });
        maxId = Math.max(maxId, post.id);
        console.log('✔ Переслано из предложки', post.id);
      } catch (e) {
        console.error('Ошибка отправки поста', post.id, e.message);
      }
      // Задержка 2 секунды между отправками
      await sleep(2000);
    }
    // После всех — обновляем lastCheckedId и сохраняем
    lastCheckedId = maxId;
    try {
      fs.writeFileSync(LAST_ID_FILE, String(lastCheckedId));
    } catch (e) {
      console.error('Ошибка записи last_id.txt:', e.message);
    }
  } catch (e) {
    console.error('Ошибка проверки предложки:', e.message);
  }
}

setInterval(checkSuggests, 60000); // Проверять раз в минуту
checkSuggests(); // Первая проверка сразу



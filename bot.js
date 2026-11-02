require("dotenv").config();
const { Bot, InlineKeyboard, GrammyError, HttpError } = require("grammy");
const { GoogleGenAI } = require("@google/genai");
const cron = require("node-cron");
const axios = require("axios");
// Buffer to collect photo albums (media groups)
const mediaGroupBuffers = new Map();
const crypto = require("crypto");

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
const bot = new Bot(process.env.BOT_TOKEN);

const ADMIN_IDS = (process.env.ADMIN_IDS || "")
  .split(",")
  .map((id) => Number(id.trim()));
const STORAGE_CHANNEL_ID = process.env.STORAGE_CHANNEL_ID;
const GROUP_CHAT_ID = process.env.GROUP_CHAT_ID;

// Generates a unique 10-character hash for any Telegram file_id
function getPhotoHash(fileId) {
  return crypto.createHash("md5").update(fileId).digest("hex").slice(0, 10);
}
function isAdmin(ctx) {
  const userId = ctx.from?.id;
  return ADMIN_IDS.includes(userId);
}

// 1. Auto-detect duplicate subjects on the same day and add (G1) / (G2)
function labelSplitGroups(subjects) {
  const counts = {};
  subjects.forEach((s) => {
    const cleanName = s.subject.replace(/\s*\(G\d+\)$/i, "").trim();
    counts[cleanName] = (counts[cleanName] || 0) + 1;
  });

  const currentGroup = {};
  return subjects.map((s) => {
    const cleanName = s.subject.replace(/\s*\(G\d+\)$/i, "").trim();
    if (counts[cleanName] > 1) {
      currentGroup[cleanName] = (currentGroup[cleanName] || 0) + 1;
      return {
        ...s,
        subject: `${cleanName} (G${currentGroup[cleanName]})`,
      };
    }
    return { ...s, subject: cleanName };
  });
}

// 2. Smart search matcher for subject lookup (prioritizes G1/G2 keywords)
function findMatchingSubject(daySubjects, searchQuery) {
  const queryTokens = searchQuery.toLowerCase().split(/\s+/);
  let bestMatch = null;
  let highestScore = -1;

  for (const item of daySubjects) {
    const nameLower = item.subject.toLowerCase();
    let score = 0;

    for (const token of queryTokens) {
      if (nameLower.includes(token)) {
        score += 2;
        // Boost score if user explicitly types 'g1' or 'g2'
        if (
          (token === "g1" && nameLower.includes("(g1)")) ||
          (token === "g2" && nameLower.includes("(g2)"))
        ) {
          score += 10;
        }
      }
    }

    if (score > highestScore && score > 0) {
      highestScore = score;
      bestMatch = item;
    }
  }

  return bestMatch;
}
// -------------------------------------------------------------
// HELPER: CHANNEL DATABASE READ / WRITE
// -------------------------------------------------------------

// -------------------------------------------------------------
// OPTIMIZED CHANNEL DATABASE STORAGE (Minified & Space-Saving)
// -------------------------------------------------------------

// -------------------------------------------------------------
// DATABASE COMPACTION & HYDRATION (Subject-based Storage)
// -------------------------------------------------------------
function compactDatabase(data) {
  const clean = {
    schedule: data.schedule || {},
    homeworks: {},
  };

  // Only keep homework entry if text or photo_file_ids exist
  for (const [subjKey, hw] of Object.entries(data.homeworks || {})) {
    if (
      hw &&
      (hw.text || (hw.photo_file_ids && hw.photo_file_ids.length > 0))
    ) {
      clean.homeworks[subjKey] = {
        text: hw.text || "",
        photo_file_ids: hw.photo_file_ids || [],
      };
    }
  }

  return clean;
}
async function getDatabaseFromChannel() {
  const chat = await bot.api.getChat(STORAGE_CHANNEL_ID);

  if (!chat.pinned_message) {
    const initialMsg = await bot.api.sendMessage(
      STORAGE_CHANNEL_ID,
      '{"schedule":{},"homeworks":{}}',
    );
    await bot.api.pinChatMessage(STORAGE_CHANNEL_ID, initialMsg.message_id);
    return {
      data: { schedule: {}, homeworks: {} },
      msgId: initialMsg.message_id,
    };
  }

  try {
    const rawData = JSON.parse(chat.pinned_message.text);
    return {
      data: {
        schedule: rawData.schedule || {},
        homeworks: rawData.homeworks || {},
      },
      msgId: chat.pinned_message.message_id,
    };
  } catch (err) {
    console.error("Failed to parse database message from channel:", err);
    return {
      data: { schedule: {}, homeworks: {} },
      msgId: chat.pinned_message.message_id,
    };
  }
}

async function saveDatabaseToChannel(data, msgId) {
  const cleanedData = compactDatabase(data);
  const jsonText = JSON.stringify(cleanedData);

  if (jsonText.length > 4000) {
    console.warn(
      `⚠️ Warning: Channel database payload length is ${jsonText.length} chars (limit 4096).`,
    );
  }

  try {
    await bot.api.editMessageText(STORAGE_CHANNEL_ID, msgId, jsonText);
  } catch (err) {
    // Ignore Telegram error if the new database content is identical to the current message
    if (
      err.description &&
      err.description.includes("message is not modified")
    ) {
      return;
    }
    throw err; // Re-throw any actual errors
  }
}
// -------------------------------------------------------------
// SMART SUBJECT MATCHING (Finds subject from text without Day)
// -------------------------------------------------------------
// -------------------------------------------------------------
// IMPROVED SMART SUBJECT MATCHING
// -------------------------------------------------------------
// -------------------------------------------------------------
// STRICT SMART SUBJECT MATCHING (With Group Disqualification)
// -------------------------------------------------------------
function findSubjectFromSchedule(schedule, inputQuery) {
  const allSubjects = new Set();
  for (const days of Object.values(schedule)) {
    if (Array.isArray(days)) {
      days.forEach((s) => allSubjects.add(s.subject));
    }
  }

  // Common connecting words ignored during subject matching
  const stopwords = new Set([
    "and",
    "the",
    "of",
    "in",
    "to",
    "for",
    "a",
    "an",
    "on",
    "with",
    "or",
  ]);

  // 1. Detect if the user typed an explicit group tag like g0, g1, g2, g6, etc.
  const userGroupMatch = inputQuery.match(/\bg(\d+)\b/i);
  const userGroupNum = userGroupMatch ? userGroupMatch[1] : null; // e.g. "0", "1", "2"

  let bestSubject = null;
  let highestScore = 0;

  for (const subjectName of allSubjects) {
    // 2. Extract group tag from subject name if present (e.g., "(G1)" -> "1")
    const subjGroupMatch = subjectName.match(/\(g(\d+)\)/i);
    const subjGroupNum = subjGroupMatch ? subjGroupMatch[1] : null;

    // STRICT RULE: If user specified a group (e.g. g0) and subject has a group (e.g. G1),
    // but they don't match -> INSTANTLY SKIP THIS SUBJECT!
    if (
      userGroupNum !== null &&
      subjGroupNum !== null &&
      userGroupNum !== subjGroupNum
    ) {
      continue;
    }

    // Clean subject name for token matching
    const cleanSubj = subjectName.toLowerCase().replace(/[\(\)]/g, " ");
    const subjWords = cleanSubj
      .split(/\s+/)
      .filter((w) => w && !stopwords.has(w));

    const inputTokens = inputQuery
      .toLowerCase()
      .replace(/[\(\)]/g, " ")
      .split(/\s+/);

    let score = 0;

    for (const inputToken of inputTokens) {
      if (stopwords.has(inputToken)) continue;

      for (const subjWord of subjWords) {
        if (subjWord === inputToken) {
          score += 10;
        } else if (subjWord.startsWith(inputToken) && inputToken.length >= 3) {
          score += 7;
        }
      }
    }

    // Bonus score if user group matches subject group exactly
    if (
      userGroupNum !== null &&
      subjGroupNum !== null &&
      userGroupNum === subjGroupNum
    ) {
      score += 15;
    }

    if (score > highestScore) {
      highestScore = score;
      bestSubject = subjectName;
    }
  }

  // Require a minimum score threshold of 7 to avoid accidental weak matches
  return highestScore >= 7 ? bestSubject : null;
}
// Convert Telegram photo to Base64 for Gemini API
async function fetchTelegramPhotoAsBase64(fileId) {
  const file = await bot.api.getFile(fileId);
  const fileUrl = `https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${file.file_path}`;
  const response = await axios.get(fileUrl, { responseType: "arraybuffer" });
  return Buffer.from(response.data).toString("base64");
}
// // -------------------------------------------------------------
// // 1. TEXT COMMAND HANDLER
// // -------------------------------------------------------------
bot.command("homework", async (ctx) => {
  await processHomeworkData(ctx, ctx.message.text || "");
});
// -------------------------------------------------------------
// WEEKLY TIMETABLE COMMAND (/weekly)
// -------------------------------------------------------------
bot.command("weekly", async (ctx) => {
  const { data: db } = await getDatabaseFromChannel();
  const schedule = db.schedule || {};

  const daysOrder = [
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  let message = `🗓️ <b>WEEKLY UNIVERSITY TIMETABLE</b>\n\n`;

  let hasData = false;

  for (const day of daysOrder) {
    const subjects = schedule[day];
    if (subjects && subjects.length > 0) {
      hasData = true;
      message += `📌 <b>${day.toUpperCase()}</b>\n`;
      subjects.forEach((sub, idx) => {
        message += `  ${idx + 1}. <b>${sub.subject}</b> (${sub.start_time} - ${sub.end_time})\n`;
      });
      message += `\n`;
    }
  }

  if (!hasData) {
    return ctx.reply(
      "❌ No weekly timetable found. Upload a timetable photo with caption <code>/timetable</code>.",
      { parse_mode: "HTML" },
    );
  }

  await ctx.reply(message, { parse_mode: "HTML" });
});

// Strips matched subject words and group tags from the start of the homework text
function extractHomeworkText(cleanText, matchedSubject) {
  if (!cleanText) return "";

  const words = cleanText.split(/\s+/);
  const stopwords = new Set([
    "and",
    "the",
    "of",
    "in",
    "to",
    "for",
    "a",
    "an",
    "on",
    "with",
    "or",
  ]);

  const subjTokens = matchedSubject
    .toLowerCase()
    .replace(/[\(\)]/g, " ")
    .split(/\s+/)
    .filter((w) => w && !stopwords.has(w));

  let i = 0;
  while (i < words.length) {
    const wordClean = words[i].toLowerCase().replace(/[\(\)]/g, "");

    const matchesSubjectToken = subjTokens.some(
      (t) =>
        t === wordClean || (wordClean.length >= 3 && t.startsWith(wordClean)),
    );
    const isGroupTag = /^g\d+$/i.test(wordClean);

    if (matchesSubjectToken || isGroupTag) {
      i++;
    } else {
      break;
    }
  }

  return words.slice(i).join(" ").trim();
}

// -------------------------------------------------------------
// VIEW & MANAGE PHOTOS COMMAND (/photos Subject)
// -------------------------------------------------------------
bot.command("photos", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized.");

  const query = ctx.match.trim();
  if (!query) {
    return ctx.reply(
      "⚠️ <b>Usage:</b> <code>/photos &lt;Subject/Group&gt;</code>\n" +
        "<b>Example:</b> <code>/photos Tech G1</code>",
      { parse_mode: "HTML" },
    );
  }

  const { data: db } = await getDatabaseFromChannel();
  const matchedSubject = findSubjectFromSchedule(db.schedule, query);

  if (!matchedSubject) {
    return ctx.reply(`❌ Subject not found for query: "<b>${query}</b>"`, {
      parse_mode: "HTML",
    });
  }

  const subjectKey = matchedSubject.toLowerCase();
  const photos = db.homeworks[subjectKey]?.photo_file_ids || [];

  if (photos.length === 0) {
    return ctx.reply(`🖼️ No photos attached for <b>${matchedSubject}</b>.`, {
      parse_mode: "HTML",
    });
  }

  await ctx.reply(
    `🖼️ <b>Attached photos for ${matchedSubject} (${photos.length}):</b>`,
    { parse_mode: "HTML" },
  );

  // Render each photo with a unique 10-char hash in callback_data
  for (const fileId of photos) {
    const photoHash = getPhotoHash(fileId);
    const keyboard = new InlineKeyboard().text(
      "🗑️ Remove Photo",
      `dp:${photoHash}:${subjectKey}`,
    );

    try {
      await ctx.api.sendPhoto(ctx.chat.id, fileId, { reply_markup: keyboard });
    } catch (err) {
      console.error("Failed to render photo in /photos command:", err);
    }
  }
});

// -------------------------------------------------------------
// INLINE BUTTON CALLBACK: REMOVE EXACT SINGLE PHOTO
// -------------------------------------------------------------
bot.callbackQuery(/^dp:([a-f0-9]{10}):(.+)$/, async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.answerCallbackQuery({
      text: "❌ Only admins can remove photos.",
      show_alert: true,
    });
  }

  const targetHash = ctx.match[1];
  const subjectKey = ctx.match[2];

  const { data: db, msgId } = await getDatabaseFromChannel();
  const hw = db.homeworks ? db.homeworks[subjectKey] : null;

  if (hw && Array.isArray(hw.photo_file_ids)) {
    // Find exact index of the single photo matching the hash
    const indexToRemove = hw.photo_file_ids.findIndex(
      (fileId) => getPhotoHash(fileId) === targetHash,
    );

    if (indexToRemove !== -1) {
      // Remove ONLY the clicked photo at indexToRemove
      hw.photo_file_ids.splice(indexToRemove, 1);
      await saveDatabaseToChannel(db, msgId);
    }
  }

  // Delete message from Telegram chat view upon button click
  try {
    await ctx.deleteMessage();
  } catch (e) {
    await ctx.editMessageCaption({
      caption: "🗑️ <i>Photo removed from database</i>",
      parse_mode: "HTML",
    });
  }

  await ctx.answerCallbackQuery("✅ Photo removed!");
});
// -------------------------------------------------------------
// REUSABLE HOMEWORK PROCESSOR (By Subject Name Only)
// -------------------------------------------------------------
async function processHomeworkData(ctx, captionText, photoFileIds = []) {
  if (!isAdmin(ctx)) {
    return ctx.reply("❌ Unauthorized: Only bot admins can set homework.");
  }

  const cleanText = captionText.replace(/^\/homework\s*/i, "").trim();

  const { data: db, msgId } = await getDatabaseFromChannel();

  // Find subject match across all timetable days
  const matchedSubject = findSubjectFromSchedule(db.schedule, cleanText);

  if (!matchedSubject) {
    return ctx.reply(
      `❌ Could not match a subject in your timetable for query: "<b>${cleanText}</b>"\n` +
        `<i>Tip: Upload a timetable first or check subject spelling.</i>`,
      { parse_mode: "HTML" },
    );
  }

  const actualHomeworkText = extractHomeworkText(cleanText, matchedSubject);
  const subjectKey = matchedSubject.toLowerCase();
  const existingHW = db.homeworks[subjectKey] || {
    text: "",
    photo_file_ids: [],
  };

  // Error if no text provided AND no photos attached
  if (!actualHomeworkText && photoFileIds.length === 0) {
    return ctx.reply(
      "⚠️ <b>Usage:</b>\n" +
        "• Set text & photo: <code>/homework Tech G1 Read chapter 4</code>\n" +
        "• Add photo only: Attach photo with caption <code>/homework Tech G1</code>",
      { parse_mode: "HTML" },
    );
  }

  // Store photos in private channel
  const storedPhotoIds = [];
  for (const rawFileId of photoFileIds) {
    try {
      const copiedMsg = await ctx.api.sendPhoto(STORAGE_CHANNEL_ID, rawFileId, {
        caption: `Homework Photo for ${matchedSubject}`,
      });
      storedPhotoIds.push(copiedMsg.photo.pop().file_id);
    } catch (err) {
      console.error("Failed to copy photo to channel:", err);
    }
  }

  // Preserve existing text if no new text was passed with photo
  // Preserve existing text if no new text passed; deduplicate photo array
  const finalHomeworkText = actualHomeworkText
    ? actualHomeworkText
    : existingHW.text;
  const updatedPhotos = Array.from(
    new Set([...(existingHW.photo_file_ids || []), ...storedPhotoIds]),
  );

  db.homeworks[subjectKey] = {
    text: finalHomeworkText,
    photo_file_ids: updatedPhotos,
  };

  await saveDatabaseToChannel(db, msgId);

  await ctx.reply(
    `✅ Homework updated for <b>${matchedSubject}</b>!\n` +
      `📝 <b>Text:</b> ${finalHomeworkText || "None assigned"}\n` +
      `🖼️ <b>Total attached pictures:</b> ${updatedPhotos.length}`,
    { parse_mode: "HTML" },
  );
}

// 1. Text-only /homework command
bot.command("homework", async (ctx) => {
  await processHomeworkData(ctx, ctx.message.text || "");
});

// 2. Photo & Album Handler
bot.on("message:photo", async (ctx, next) => {
  const mediaGroupId = ctx.message.media_group_id;
  const caption = ctx.message.caption || "";

  // A) IF USER SENDS AN ALBUM (MULTIPLE PHOTOS AT ONCE)
  if (mediaGroupId) {
    if (!mediaGroupBuffers.has(mediaGroupId)) {
      mediaGroupBuffers.set(mediaGroupId, {
        ctx: ctx,
        caption: caption,
        photos: [],
      });

      // Wait 500ms for all photos in the album to arrive
      setTimeout(async () => {
        const albumData = mediaGroupBuffers.get(mediaGroupId);
        mediaGroupBuffers.delete(mediaGroupId);

        if (
          albumData &&
          albumData.caption.toLowerCase().startsWith("/homework")
        ) {
          await processHomeworkData(
            albumData.ctx,
            albumData.caption,
            albumData.photos,
          );
        }
      }, 500);
    }

    const currentBuffer = mediaGroupBuffers.get(mediaGroupId);
    if (caption && !currentBuffer.caption) {
      currentBuffer.caption = caption;
    }
    const photo = ctx.message.photo.pop();
    currentBuffer.photos.push(photo.file_id);
    return;
  }

  // B) SINGLE PHOTO WITH /homework CAPTION
  if (caption.toLowerCase().startsWith("/homework")) {
    const photo = ctx.message.photo.pop();
    return processHomeworkData(ctx, caption, [photo.file_id]);
  }

  // C) SINGLE PHOTO WITH /timetable CAPTION
  // C) SINGLE PHOTO WITH /timetable CAPTION
  if (caption.includes("/timetable")) {
    if (!isAdmin(ctx)) {
      return ctx.reply(
        "❌ Unauthorized: Only bot admins can upload timetables.",
      );
    }

    const statusMsg = await ctx.reply(
      "⏳ Analyzing timetable image with Gemini AI...",
    );

    try {
      const photo = ctx.message.photo.pop();
      const base64Data = await fetchTelegramPhotoAsBase64(photo.file_id);

      const prompt = `
        Analyze this timetable image. Extract subjects, start times, and end times for each day of the week.
        If a subject appears twice at the same time slot (split groups), label them as "(G1)" and "(G2)".
        Max 4 subjects per day.

        Return ONLY a valid JSON object structured like this:
        {
          "Monday": [
            { "subject": "Technical Communication (G1)", "start_time": "10:00", "end_time": "11:20" }
          ]
        }
      `;

      const response = await ai.models.generateContent({
        model: "gemini-3.5-flash-lite",
        contents: [
          { inlineData: { mimeType: "image/jpeg", data: base64Data } },
          { text: prompt },
        ],
        config: { responseMimeType: "application/json" },
      });

      const parsedSchedule = JSON.parse(response.text);
      const { data: db, msgId } = await getDatabaseFromChannel();

      // Fix: Preserve existing schedule days and merge newly parsed days
      const currentSchedule = db.schedule || {};

      for (const [day, subjects] of Object.entries(parsedSchedule)) {
        // Auto-label duplicate subjects (G1/G2) if Gemini missed any
        const taggedSubjects = labelSplitGroups(subjects);
        currentSchedule[day] = taggedSubjects;
      }

      // Save updated schedule back to channel
      db.schedule = currentSchedule;
      await saveDatabaseToChannel(db, msgId);

      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "✅ Timetable successfully updated and saved to Channel database!",
      );
    } catch (err) {
      console.error("Timetable parsing error:", err);
      await ctx.api.editMessageText(
        ctx.chat.id,
        statusMsg.message_id,
        "❌ Failed to parse timetable image. Please try again.",
      );
    }
  } else {
    return next();
  }
});
// -------------------------------------------------------------
// DAILY AUTOMATED REMINDER (Case-Insensitive & Space-Trimmed)
// -------------------------------------------------------------
async function sendTomorrowReminder() {
  const days = [
    "Sunday",
    "Monday",
    "Tuesday",
    "Wednesday",
    "Thursday",
    "Friday",
    "Saturday",
  ];
  const tomorrowDate = new Date();
  tomorrowDate.setDate(tomorrowDate.getDate() + 1);
  const tomorrowName = days[tomorrowDate.getDay()];

  const { data: db } = await getDatabaseFromChannel();
  const schedule = db.schedule || {};

  // Case-insensitive & trimmed day lookup (matches "Tuesday", "tuesday", or "Tuesday ")
  const matchedDayKey = Object.keys(schedule).find(
    (key) => key.trim().toLowerCase() === tomorrowName.toLowerCase(),
  );

  const tomorrowSubjects = matchedDayKey ? schedule[matchedDayKey] : [];

  if (!tomorrowSubjects || tomorrowSubjects.length === 0) {
    console.log(`No subjects scheduled for tomorrow (${tomorrowName}).`);
    return;
  }

  let message = `📅 <b>Tomorrow's Schedule (${tomorrowName})</b>\n\n`;

  tomorrowSubjects.forEach((item, index) => {
    const subjKey = item.subject.toLowerCase();
    const homework = db.homeworks ? db.homeworks[subjKey] : null;

    message += `<b>${index + 1}. ${item.subject}</b>\n`;
    message += `⏰ ${item.start_time} - ${item.end_time}\n`;
    if (homework && homework.text) {
      message += `📝 <b>Homework:</b> ${homework.text}\n`;
    } else {
      message += `📝 <b>Homework:</b> None assigned\n`;
    }
    message += `\n`;
  });

  try {
    // 1. Send & Pin Schedule Summary
    const sentMsg = await bot.api.sendMessage(GROUP_CHAT_ID, message, {
      parse_mode: "HTML",
    });
    await bot.api.pinChatMessage(GROUP_CHAT_ID, sentMsg.message_id);

    // 2. Send Homework Photo Albums if assigned for tomorrow's subjects
    for (const item of tomorrowSubjects) {
      const subjKey = item.subject.toLowerCase();
      const photos =
        db.homeworks && db.homeworks[subjKey]
          ? db.homeworks[subjKey].photo_file_ids || []
          : [];

      if (photos.length === 1) {
        try {
          await bot.api.sendPhoto(GROUP_CHAT_ID, photos[0], {
            caption: `📸 Homework picture for <b>${item.subject}</b>`,
            parse_mode: "HTML",
          });
        } catch (err) {
          console.error(
            `Failed to send single photo for ${item.subject}:`,
            err,
          );
        }
      } else if (photos.length > 1) {
        try {
          const mediaGroup = photos.map((fileId, idx) => ({
            type: "photo",
            media: fileId,
            caption:
              idx === 0
                ? `📸 Homework pictures (${photos.length}) for <b>${item.subject}</b>`
                : "",
            parse_mode: "HTML",
          }));

          await bot.api.sendMediaGroup(GROUP_CHAT_ID, mediaGroup);
        } catch (err) {
          console.error(`Failed to send media group for ${item.subject}:`, err);
        }
      }
    }
  } catch (err) {
    console.error("Failed to send daily reminder:", err);
  }
}

// -------------------------------------------------------------
// 3. DAILY AUTOMATED REMINDER (CRON JOB)
// -------------------------------------------------------------
// async function sendTomorrowReminder() {
//   const days = [
//     "Sunday",
//     "Monday",
//     "Tuesday",
//     "Wednesday",
//     "Thursday",
//     "Friday",
//     "Saturday",
//   ];
//   const tomorrowDate = new Date();
//   //   tomorrowDate.setDate(tomorrowDate.getDate() + 1);
//   tomorrowDate.setDate(tomorrowDate.getDate());
//   const tomorrowName = days[tomorrowDate.getDay()];

//   const { data: db } = await getDatabaseFromChannel();
//   const tomorrowSubjects = db[tomorrowName] || [];

//   if (tomorrowSubjects.length === 0) {
//     console.log(`No subjects scheduled for tomorrow (${tomorrowName}).`);
//     return;
//   }

//   let message = `📅 **Tomorrow's Schedule (${tomorrowName})**\n\n`;

//   tomorrowSubjects.forEach((item, index) => {
//     message += `**${index + 1}. ${item.subject}**\n`;
//     message += `⏰ ${item.start_time} - ${item.end_time}\n`;
//     if (item.homework && item.homework.text) {
//       message += `📝 **Homework:** ${item.homework.text}\n`;
//     } else {
//       message += `📝 **Homework:** None assigned\n`;
//     }
//     message += `\n`;
//   });

//   try {
//     // 1. Send schedule summary to student group
//     const sentMsg = await bot.api.sendMessage(GROUP_CHAT_ID, message, {
//       parse_mode: "Markdown",
//     });

//     // 2. Pin the message in student group
//     await bot.api.pinChatMessage(GROUP_CHAT_ID, sentMsg.message_id);

//     // 3. Send attached homework photos if present
//     for (const item of tomorrowSubjects) {
//       if (item.homework && item.homework.photo_file_id) {
//         await bot.api.sendPhoto(GROUP_CHAT_ID, item.homework.photo_file_id, {
//           caption: `📸 Homework picture for **${item.subject}**`,
//           parse_mode: "Markdown",
//         });
//       }
//     }
//   } catch (err) {
//     console.error("Failed to send daily reminder:", err);
//   }
// }
bot.command("clearhomework", async (ctx) => {
  if (!isAdmin(ctx)) return ctx.reply("❌ Unauthorized.");

  const args = ctx.match.trim().split(/\s+/);
  if (args.length < 2) {
    return ctx.reply(
      "⚠️ Usage: `/clearhomework <Day> <Subject>`\nExample: `/clearhomework Monday Math`",
      { parse_mode: "Markdown" },
    );
  }

  const day = args[0].charAt(0).toUpperCase() + args[0].slice(1).toLowerCase();
  const subjectQuery = args[1].toLowerCase();

  const { data: db, msgId } = await getDatabaseFromChannel();
  if (!db[day]) return ctx.reply(`❌ No subjects found for ${day}.`);

  const subjectObj = db[day].find((s) =>
    s.subject.toLowerCase().includes(subjectQuery),
  );
  if (!subjectObj)
    return ctx.reply(`❌ Could not find subject "${args[1]}" on ${day}.`);

  subjectObj.homework = { text: "", photo_file_ids: [] };
  await saveDatabaseToChannel(db, msgId);

  await ctx.reply(
    `🗑️ Cleared homework and photos for **${subjectObj.subject}** (${day}).`,
    { parse_mode: "Markdown" },
  );
});

// Daily Cron Job at 20:00 (8 PM)
cron.schedule("0 20 * * *", () => {
  console.log("Running daily reminder task...");
  sendTomorrowReminder();
});

bot.catch((err) => {
  const ctx = err.ctx;
  console.error(
    `[grammY] Error while handling update ${ctx.update.update_id}:`,
  );
  const e = err.error;
  if (e instanceof GrammyError) {
    console.error("Error in request:", e.description);
  } else if (e instanceof HttpError) {
    console.error("Could not contact Telegram:", e);
  } else {
    console.error("Unknown error:", e);
  }
});
// 3. Test reminder command (Admin Restricted)
bot.command("testreminder", async (ctx) => {
  if (!isAdmin(ctx)) {
    return ctx.reply(
      "❌ Unauthorized: Only admins can trigger test reminders.",
    );
  }
  await ctx.reply("🔄 Triggering tomorrow's reminder test...");
  await sendTomorrowReminder();
});
bot.command("debugdb", async (ctx) => {
  if (!isAdmin(ctx)) return;
  const { data: db } = await getDatabaseFromChannel();
  await ctx.reply(`<code>${JSON.stringify(db, null, 2)}</code>`, {
    parse_mode: "HTML",
  });
});

// Start Telegram Bot
bot.start({
  onStart: () =>
    console.log(
      "Bot running without local database (Channel storage active)...",
    ),
});

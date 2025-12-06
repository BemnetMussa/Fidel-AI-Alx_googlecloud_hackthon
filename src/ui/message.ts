import { Telegraf, Markup } from "telegraf";
import { gradeMenu } from "../keyboards/gradeMenu";
import { Grade, subjectMenu, subjectsAfterStream } from "../keyboards/subjectMenu";
import { topicMenu } from "../keyboards/topicMenu";
import { mainMenu } from "../keyboards/mainMenu";
import { postExplanationMenu } from "../keyboards/postExplanationMenu";
import { renderMenu } from "./renderer";
import llm from "../llm_call/llm_call";
import { search } from "../rag/search";
import {
  ExplainPrompt,
  SummaryPrompt,
  QuizPrompt,
  QuestionPrompt,
  VideoSearchPrompt,
  ImagePrompt,
} from "../prompt/createPrompt";
import { getUserState, setUserState, pushNavigation, popNavigation, clearUserState } from "../utils/userState";
import { searchYouTubeVideos, formatYouTubeVideos } from "../utils/youtubeSearch";
import { generateImage } from "../utils/imageGeneration";
import telegramifyMarkdown from 'telegramify-markdown';

// Telegram message limit is 4096 characters
const MAX_MESSAGE_LENGTH = 4096;

/**
 * Splits a long message into chunks that fit within Telegram's message limit
 * Tries to split at paragraph boundaries when possible
 */
function splitMessage(text: string, maxLength: number = MAX_MESSAGE_LENGTH): string[] {
  if (text.length <= maxLength) {
    return [text];
  }

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLength) {
    // Try to split at a paragraph break (double newline) first
    const paragraphBreak = remaining.lastIndexOf('\n\n', maxLength);
    // If no paragraph break, try single newline
    const lineBreak = remaining.lastIndexOf('\n', maxLength);
    // If no line break, split at word boundary
    const wordBreak = remaining.lastIndexOf(' ', maxLength);
    
    let splitIndex = paragraphBreak > maxLength * 0.5 ? paragraphBreak 
                   : lineBreak > maxLength * 0.5 ? lineBreak
                   : wordBreak > maxLength * 0.5 ? wordBreak
                   : maxLength;

    chunks.push(remaining.substring(0, splitIndex).trim());
    remaining = remaining.substring(splitIndex).trim();
  }

  if (remaining.length > 0) {
    chunks.push(remaining);
  }

  return chunks;
}

// markdown util function
const markDownUtil = (text: string) => {
  return telegramifyMarkdown(text, "escape")
}

/**
 * Send post-explanation menu after an explanation or question response
 */
async function sendPostExplanationMenu(ctx: any) {
  await ctx.reply("✨ <b>What would you like to explore next?</b>\n\nChoose an option below to continue learning:", {
    parse_mode: "HTML",
    ...postExplanationMenu,
  });
}

export const setupStartUI = (bot: Telegraf) => {
  // --- /start command ---
  bot.start(async (ctx) => {
    clearUserState(ctx.from!.id);
    return renderMenu(
      ctx,
      "👋 <b>Welcome to Fidel — Your AI Learning Companion!</b>\n\n✨ Get instant explanations, practice questions, and personalized help for any topic.\n\nWhat would you like to do?",
      mainMenu
    );
  });

  // --- Main menu actions ---
  bot.action("mode_explain", async (ctx) => {
    await ctx.answerCbQuery();
    setUserState(ctx.from!.id, { mode: "explain" });
    pushNavigation(ctx.from!.id, "main", {});
    return renderMenu(
      ctx,
      "🎓 <b>Start Learning</b>\n\nSelect your grade to begin:",
      gradeMenu
    );
  });

  bot.action("mode_question", async (ctx) => {
    await ctx.answerCbQuery();
    setUserState(ctx.from!.id, { mode: "question", waitingForQuestion: true });
    await ctx.reply(
      "💬 <b>Ask Your Question</b>\n\n" +
      "Type your question below and I'll help you understand! 💡\n\n<i>You can ask about any topic, concept, or problem you're working on.</i>",
      { parse_mode: "HTML" }
    );
  });

  // --- grade selected ---
  bot.action(/grade_.+/, async (ctx) => {
    console.log("grade selection", ctx.match);
    const grade = Number(ctx.match[0].split("_")[1]) as Grade;
    console.log("this is selected grade:", grade);
    await ctx.answerCbQuery();

    setUserState(ctx.from!.id, { grade });
    pushNavigation(ctx.from!.id, "grade", { grade });

    return renderMenu(ctx, `📘 <b>Grade ${grade}</b>\n\nSelect your subject:`, subjectMenu(grade));
  });

  bot.action(/^stream_(\d+)_(natural|social)$/, async (ctx) => {
    const grade = Number(ctx.match[1]) as 11 | 12;
    const stream = ctx.match[2] as "natural" | "social";

    console.log("stream selection", ctx.match);
    await ctx.answerCbQuery();

    setUserState(ctx.from!.id, { grade });
    pushNavigation(ctx.from!.id, "stream", { grade, stream });

    return renderMenu(
      ctx,
      `✅ <b>${stream === "natural" ? "🌿 Natural" : "🏛 Social"} Science Stream</b> (Grade ${grade})\n\nChoose a subject to explore:`,
      subjectsAfterStream(grade, stream)
    );
  });

  // --- subject selected ---
  bot.action(/subject_.+/, async (ctx) => {
    const [_, grade, subject] = ctx.match[0].split("_");
    await ctx.answerCbQuery();

    if (!grade || !subject) {
      return ctx.reply("❌ Invalid selection. Please try again.");
    }

    setUserState(ctx.from!.id, { subject });
    pushNavigation(ctx.from!.id, "subject", { grade: Number(grade), subject });

    return renderMenu(
      ctx,
      `📚 <b>${subject}</b>\n\nSelect a topic to learn about:`,
      topicMenu(Number(grade), subject)
    );
  });

  // --- topic selected ---
  bot.action(/topic_.+/, async (ctx) => {
    const parts = ctx.match[0].split("_");
    const grade = parts[1];
    const subject = parts[2];
    const topic = parts.slice(3).join(" ");

    console.log("Topic selected:", { grade, subject, topic });

    // Remove loading spinner instantly
    await ctx.answerCbQuery("Generating explanation... ⚡");

    // Show a temporary message so user knows it's working
    const loadingMsg = await ctx.reply(
      `✨ <b>Generating explanation for ${topic}</b>\n\n📚 ${subject} • Grade ${grade}\n\n⚡ This may take 10–30 seconds...`,
      { parse_mode: "HTML" }
    );

    // Save state
    setUserState(ctx.from!.id, { topic });
    pushNavigation(ctx.from!.id, "topic", { grade, subject, topic });

    try {
      // Fix: changed cttopic to topic
      const relevantChunks = await search(topic, ctx, loadingMsg);
      // 2. Combine chunks into context (with length safety)
      const context = relevantChunks.join("\n\n").trim();

      console.log("relevant chunk context: ", context);

      // Optional: truncate if context is too long, to be safe
      const maxContextLength = 50_000; // characters
      const truncatedContext = context.slice(0, maxContextLength);

      console.log("relevant truncated chunk context: ", truncatedContext);

      // Fix: Correct parameter order for ExplainPrompt
      const prompt = ExplainPrompt(topic, subject, grade, truncatedContext);

      // 1. Create a logic to abort the request if it takes too long (e.g., 25 seconds)
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 25000);

      // 2. Pass the signal to the invoke call
      const response = await llm.invoke(prompt, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId); // Clear timer if successful

      const text = typeof response.content === "string"
        ? response.content
        : "No explanation generated.";

      const header = `📖 *${topic}*\n\n📚 ${subject} • Grade ${grade}\n\n${"─".repeat(25)}\n\n`;
      const fullMessage = header + text;

      const fullResponse = markDownUtil(fullMessage)

      // Save explanation to state
      setUserState(ctx.from!.id, { lastExplanation: text });

      // Split message into chunks if it's too long
      const chunks = splitMessage(fullResponse, MAX_MESSAGE_LENGTH);

      // Ensure we have at least one chunk
      if (chunks.length === 0) {
        throw new Error("Failed to split message");
      }

      // Edit the loading message with the first chunk
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        `${chunks[0]!}`,
        { parse_mode: "MarkdownV2" }
      );

      // Send remaining chunks as new messages
      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(`${chunks[i]!}`, { parse_mode: "MarkdownV2" });
      }

      // Send post-explanation menu
      await sendPostExplanationMenu(ctx);
    } catch (error: any) {
      console.error("LLM failed:", error);

      let userMessage = "Sorry, I couldn't generate the explanation right now. Please try again.";

      // Handle the specific Abort/Timeout error
      if (error.name === "AbortError" || error.name === "TimeoutError") {
        userMessage = "⚠️ The AI is taking too long to respond. Please try again in a few seconds.";
      }
      // Handle API key/model not found errors
      else if (error.message?.includes("404") || error.message?.includes("not found")) {
        userMessage =
          "❌ AI service configuration error. Please contact the bot administrator.\n\n(API key may need Generative Language API enabled in Google Cloud Console)";
      }
      // Handle authentication errors
      else if (
        error.message?.includes("401") ||
        error.message?.includes("403") ||
        error.message?.includes("API key")
      ) {
        userMessage =
          "❌ AI service authentication error. Please contact the bot administrator.\n\n(API key may be invalid or missing permissions)";
      }

      // Wrap this in a try/catch too, in case the message was deleted by the user
      try {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          undefined,
          userMessage
        );
      } catch (e) {
        console.log("Could not update error message (user might have blocked bot or deleted chat)");
      }
    }
  });

  // --- Question handling (text input) ---
  bot.on("text", async (ctx) => {
    const userId = ctx.from!.id;
    const state = getUserState(userId);
    const text = ctx.message.text;

    // Ignore commands
    if (text?.startsWith("/")) {
      return;
    }

    // Check if user is waiting for a question
    if (state.waitingForQuestion && text) {
      setUserState(userId, { waitingForQuestion: false });

      const loadingMsg = await ctx.reply("💭 <b>Analyzing your question...</b>\n\n✨ Finding the best way to help you understand!", {
        parse_mode: "HTML",
      });

      try {
        // Try to get context from RAG if we have topic info
        let context = "";
        if (state.topic) {
          try {
            const relevantChunks = await search(state.topic, ctx, loadingMsg, 3);
            context = relevantChunks.join("\n\n").trim();
          } catch (e) {
            console.log("RAG search failed for question, continuing without context");
          }
        }

        const prompt = QuestionPrompt(text, context, state.subject, state.grade?.toString());

        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 25000);

        const response = await llm.invoke(prompt, {
          signal: controller.signal,
        });

        clearTimeout(timeoutId);

        const answer = typeof response.content === "string" ? response.content : "I couldn't generate an answer.";

        const header = `💬 *Your Question:*\n${text}\n\n${"─".repeat(25)}\n\n✨ *Answer:*\n\n`
        const fullMessage = header + answer

        const fullResponse = markDownUtil(fullMessage)

        // Update loading message
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          undefined,
          `${fullResponse}`,
          { parse_mode: "MarkdownV2" }
        );

        // Save answer as last explanation for summary
        setUserState(userId, { lastExplanation: answer });

        // Send post-explanation menu
        await sendPostExplanationMenu(ctx);
      } catch (error: any) {
        console.error("Question handling failed:", error);

        let userMessage = "Sorry, I couldn't process your question right now. Please try again.";

        if (error.name === "AbortError" || error.name === "TimeoutError") {
          userMessage = "⚠️ The AI is taking too long to respond. Please try again in a few seconds.";
        }

        try {
          await ctx.telegram.editMessageText(
            ctx.chat!.id,
            loadingMsg.message_id,
            undefined,
            userMessage
          );
        } catch (e) {
          await ctx.reply(userMessage);
        }
      }
    }
  });

  // --- Post-explanation actions ---

  // Lesson Summary
  bot.action("action_summary", async (ctx) => {
    await ctx.answerCbQuery("Generating summary...");
    const state = getUserState(ctx.from!.id);

    if (!state.lastExplanation) {
      return ctx.reply("❌ No explanation found to summarize. Please generate an explanation first.");
    }

    const loadingMsg = await ctx.reply("📝 <b>Creating your lesson summary...</b>\n\n✨ Condensing the key points for quick review!", { parse_mode: "HTML" });

    try {
      const prompt = SummaryPrompt(state.lastExplanation);
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 20000);

      const response = await llm.invoke(prompt, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const summary = typeof response.content === "string" ? response.content : "Could not generate summary.";

      const header = `📖 *Lesson Summary*\n\n`

      const fullMessage = header + summary

      const fullResponse = markDownUtil(fullMessage)

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        `${fullResponse}`,
        { parse_mode: "MarkdownV2" }
      );

      await sendPostExplanationMenu(ctx);
    } catch (error: any) {
      console.error("Summary generation failed:", error);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        "❌ Could not generate summary. Please try again."
      );
    }
  });

  // Practice Questions
  bot.action("action_practice", async (ctx) => {
    await ctx.answerCbQuery("Generating practice questions...");
    const state = getUserState(ctx.from!.id);

    if (!state.topic) {
      return ctx.reply("❌ No topic found. Please select a topic first.");
    }

    const loadingMsg = await ctx.reply("✏️ <b>Generating practice questions...</b>\n\n🎯 Creating questions to test your understanding!", { parse_mode: "HTML" });

    try {
      // Get context from RAG
      let context = "";
      try {
        const relevantChunks = await search(state.topic, ctx, loadingMsg, 5);
        context = relevantChunks.join("\n\n").trim();
      } catch (e) {
        console.log("RAG search failed for practice questions");
      }

      const prompt = QuizPrompt(
        context,
        state.topic,
        state.grade?.toString() || "",
        5 // Generate 5 questions
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 30000);

      const response = await llm.invoke(prompt, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const content = typeof response.content === "string" ? response.content : "{}";

      const header = `🧑 <b>Practice Questions</b>\n\n`

      const fullMessage = header + content

      const fullResponse = markDownUtil(fullMessage)

      // Try to parse JSON response
      let quizData: any;
      try {
        // Extract JSON from markdown code blocks if present
        const jsonMatch = content.match(/```(?:json)?\s*(\{[\s\S]*\})\s*```/) || content.match(/(\{[\s\S]*\})/);
        const jsonStr = jsonMatch && jsonMatch[1] ? jsonMatch[1] : content;
        quizData = JSON.parse(jsonStr);
      } catch (e) {
        // If JSON parsing fails, format as plain text
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          undefined,
          `${fullResponse}`,
          { parse_mode: "MarkdownV2" }
        );
        await sendPostExplanationMenu(ctx);
        return;
      }

      // Format quiz questions
      let fullQuiz = `🧑 *Practice Questions: ${quizData.topic || state.topic}*\n\n`;

      let quizText = markDownUtil(fullQuiz)
      
      if (quizData.questions && Array.isArray(quizData.questions)) {
        quizData.questions.forEach((q: any, index: number) => {
          quizText += `<b>Question ${index + 1}:</b> ${q.question}\n\n`;
          if (q.options && Array.isArray(q.options)) {
            q.options.forEach((opt: string) => {
              quizText += `${opt}\n`;
            });
          }
          quizText += `\n✅ <b>Correct Answer:</b> ${q.correct || "N/A"}\n`;
          if (q.explanation) {
            quizText += `💡 <i>${q.explanation}</i>\n\n`;
          }
          quizText += "─".repeat(20) + "\n\n";
        });
      } else {
        quizText += content;
      }

      const chunks = splitMessage(quizText, MAX_MESSAGE_LENGTH);

      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        chunks[0]!,
        { parse_mode: "MarkdownV2" }
      );

      for (let i = 1; i < chunks.length; i++) {
        await ctx.reply(chunks[i]!, { parse_mode: "MarkdownV2" });
      }

      await sendPostExplanationMenu(ctx);
    } catch (error: any) {
      console.error("Practice questions generation failed:", error);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        "❌ Could not generate practice questions. Please try again."
      );
    }
  });

  // Video Tutorial
  bot.action("action_video", async (ctx) => {
    await ctx.answerCbQuery("Searching for videos...");
    const state = getUserState(ctx.from!.id);

    if (!state.topic) {
      return ctx.reply("❌ No topic found. Please select a topic first.");
    }

    const loadingMsg = await ctx.reply("🎥 <b>Finding educational videos...</b>\n\n🔍 Searching for the best tutorials to help you learn!", { parse_mode: "HTML" });

    try {
      // Generate search query using LLM
      const searchPrompt = VideoSearchPrompt(
        state.topic,
        state.subject || "",
        state.grade?.toString() || ""
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await llm.invoke(searchPrompt, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const searchQuery = typeof response.content === "string"
        ? response.content.trim().replace(/["']/g, "")
        : `${state.topic} ${state.subject} tutorial grade ${state.grade}`;

      // Search YouTube
      const videos = await searchYouTubeVideos(searchQuery, 5);

      if (videos.length === 0) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          undefined,
          `❌ No videos found for "${searchQuery}".\n\nTry searching manually on YouTube.`
        );
        return;
      }

      const videoMessage = formatYouTubeVideos(videos);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        videoMessage,
        { parse_mode: "HTML" }
      );

      await sendPostExplanationMenu(ctx);
    } catch (error: any) {
      console.error("Video search failed:", error);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        "❌ Could not search for videos. Please try again later."
      );
    }
  });

  // AI Image Explanation
  bot.action("action_image", async (ctx) => {
    await ctx.answerCbQuery("Generating image...");
    const state = getUserState(ctx.from!.id);

    if (!state.topic) {
      return ctx.reply("❌ No topic found. Please select a topic first.");
    }

    const loadingMsg = await ctx.reply("🖼️ <b>Creating AI visual explanation...</b>\n\n🎨 Generating an image to help you visualize the concept!", { parse_mode: "HTML" });

    try {
      // Generate image prompt using LLM
      const imagePromptText = ImagePrompt(
        state.topic,
        state.subject || "",
        state.grade?.toString() || "",
        state.lastExplanation
      );

      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15000);

      const response = await llm.invoke(imagePromptText, {
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      const imagePrompt = typeof response.content === "string"
        ? response.content.trim().replace(/["']/g, "")
        : `Educational diagram explaining ${state.topic} for grade ${state.grade} students`;

      // Generate image
      const imageUrl = await generateImage(imagePrompt);

      if (!imageUrl) {
        await ctx.telegram.editMessageText(
          ctx.chat!.id,
          loadingMsg.message_id,
          undefined,
          `❌ Image generation is currently unavailable.\n\n` +
          `💡 <b>Tip:</b> You can search for images on Google Images or ask me to describe a diagram instead!`,
          { parse_mode: "HTML" }
        );
        await sendPostExplanationMenu(ctx);
        return;
      }

      // Send image
      if (imageUrl.startsWith("data:")) {
        // Base64 image
        const base64Data = imageUrl.split(",")[1];
        if (!base64Data) {
          throw new Error("Invalid base64 image data");
        }
        const imageBuffer = Buffer.from(base64Data, "base64");
        await ctx.telegram.sendPhoto(ctx.chat!.id, { source: imageBuffer }, {
          caption: `🖼️ <b>AI Image Explanation: ${state.topic}</b>`,
          parse_mode: "HTML",
        });
      } else {
        // URL
        await ctx.telegram.sendPhoto(ctx.chat!.id, imageUrl, {
          caption: `🖼️ <b>AI Image Explanation: ${state.topic}</b>`,
          parse_mode: "HTML",
        });
      }

      await ctx.telegram.deleteMessage(ctx.chat!.id, loadingMsg.message_id);
      await sendPostExplanationMenu(ctx);
    } catch (error: any) {
      console.error("Image generation failed:", error);
      await ctx.telegram.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        undefined,
        "❌ Could not generate image. Please try again later.\n\n💡 <b>Note:</b> Image generation requires API keys. Contact the administrator if this persists.",
        { parse_mode: "HTML" }
      );
    }
  });

  // I Have a Question (from post-explanation menu)
  bot.action("action_question", async (ctx) => {
    await ctx.answerCbQuery();
    setUserState(ctx.from!.id, { waitingForQuestion: true });
    await ctx.reply(
      "💬 <b>Ask Your Question</b>\n\n" +
      "Type your question below and I'll help you understand! 💡\n\n<i>You can ask about any topic, concept, or problem you're working on.</i>",
      { parse_mode: "HTML" }
    );
  });

  // --- Navigation ---
  bot.action("nav_home", async (ctx) => {
    await ctx.answerCbQuery();
    clearUserState(ctx.from!.id);
    return renderMenu(
      ctx,
      "👋 <b>Welcome to Fidel — Your AI Learning Companion!</b>\n\n✨ Get instant explanations, practice questions, and personalized help for any topic.\n\nWhat would you like to do?",
      mainMenu
    );
  });

  bot.action("nav_back", async (ctx) => {
    await ctx.answerCbQuery();
    const userId = ctx.from!.id;
    const navItem = popNavigation(userId);

    if (!navItem) {
      return renderMenu(
        ctx,
        "👋 <b>Welcome to Fidel — Your AI Learning Companion!</b>\n\n✨ Get instant explanations, practice questions, and personalized help for any topic.\n\nWhat would you like to do?",
        mainMenu
      );
    }

    const state = getUserState(userId);

    switch (navItem.type) {
      case "topic":
        // Go back to subject selection
        if (navItem.data.subject && navItem.data.grade) {
          return renderMenu(
            ctx,
            `📚 <b>${navItem.data.subject}</b>\n\nSelect a topic to learn about:`,
            topicMenu(Number(navItem.data.grade), navItem.data.subject)
          );
        }
        break;
      case "subject":
        // Go back to grade selection
        if (navItem.data.grade) {
          setUserState(userId, { grade: navItem.data.grade });
          return renderMenu(
            ctx,
            `📘 <b>Grade ${navItem.data.grade}</b>\n\nSelect your subject:`,
            subjectMenu(navItem.data.grade as Grade)
          );
        }
        break;
      case "stream":
        // Go back to grade selection
        if (navItem.data.grade) {
          return renderMenu(
            ctx,
            `📘 <b>Grade ${navItem.data.grade}</b>\n\nSelect your subject:`,
            subjectMenu(navItem.data.grade as Grade)
          );
        }
        break;
      case "grade":
      case "main":
      default:
        return renderMenu(
          ctx,
          "👋 <b>Welcome to Fidel — Your AI Learning Companion!</b>\n\n✨ Get instant explanations, practice questions, and personalized help for any topic.\n\nWhat would you like to do?",
          mainMenu
        );
    }

    // Fallback to main menu
    return renderMenu(
      ctx,
      "👋 <b>Welcome to Fidel — Your AI Learning Companion!</b>\n\n✨ Get instant explanations, practice questions, and personalized help for any topic.\n\nWhat would you like to do?",
      mainMenu
    );
  });
};

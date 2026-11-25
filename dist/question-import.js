(() => {
  "use strict";

  const maxFiles = 10;
  const maxFileBytes = 25 * 1024 ** 2;
  const maxBatchBytes = 60 * 1024 ** 2;
  const chinese = /\p{Script=Han}/u;
  const imageExtension = /\.(png|jpe?g|webp)$/i;
  const slidePath = /^ppt\/slides\/slide\d+\.xml$/i;
  const relationPath = /^ppt\/slides\/_rels\/slide\d+\.xml\.rels$/i;
  const mediaPath = /^ppt\/media\/[^/]+\.(?:png|jpe?g|webp)$/i;
  const presentationPaths = new Set(["ppt/presentation.xml", "ppt/_rels/presentation.xml.rels"]);
  const decoder = new TextDecoder();
  const segmenter = new Intl.Segmenter("zh-CN", { granularity: "word" });
  const ignored = new Set(("about after also because before being could during from have into just more most only other over should some such than that their them then there these they this those through under very were what when where which while will with would your " +
    "一些 一个 这个 可以 进行 就是 以及 或者 需要 如果 所以 因为 由于 对于 关于 然而 这样 那样 具有 主要 例如 通过 并且").split(" "));
  const vendor = name => new URL("vendor/" + name, document.baseURI).href;

  function loadVendor(globalName, name) {
    if (window[globalName]) return Promise.resolve(window[globalName]);
    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = vendor(name);
      script.onload = () => window[globalName] ? resolve(window[globalName]) : reject(new Error("Unable to initialize " + name));
      script.onerror = () => {
        script.remove();
        reject(new Error("Unable to load " + name));
      };
      document.head.append(script);
    });
  }

  function xml(data) {
    if (!data) return null;
    const doc = new DOMParser().parseFromString(decoder.decode(data), "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("The PowerPoint file has invalid slide data.");
    return doc;
  }

  function elements(root, localName) {
    return Array.from(root?.getElementsByTagNameNS("*", localName) || []);
  }

  function attribute(element, name) {
    return [...element.attributes].find(attr => attr.localName === name && attr.namespaceURI)?.value;
  }

  function zipPath(current, target) {
    if (!target) return "";
    const url = new URL(target.replaceAll("\\", "/"), "https://slides.invalid/" + current);
    return url.origin === "https://slides.invalid" ? decodeURIComponent(url.pathname.slice(1)) : "";
  }

  function relations(files, path, current) {
    return new Map(elements(xml(files[path]), "Relationship").filter(node => node.getAttribute("TargetMode") !== "External")
      .map(node => [node.getAttribute("Id"), zipPath(current, node.getAttribute("Target"))]));
  }

  async function readSlides(file, recognize) {
    const { unzip } = await loadVendor("fflate", "fflate.min.js");
    const input = new Uint8Array(await file.arrayBuffer());
    let expanded = 0;
    let entries = 0;
    const files = await new Promise((resolve, reject) => unzip(input, {
      filter(entry) {
        if (!slidePath.test(entry.name) && !relationPath.test(entry.name) && !mediaPath.test(entry.name) && !presentationPaths.has(entry.name)) return false;
        expanded += entry.originalSize;
        if (++entries > 400 || expanded > 70 * 1024 ** 2 || entry.originalSize > 12 * 1024 ** 2) {
          throw new Error("This deck contains too much slide data. Split it into smaller files.");
        }
        return true;
      }
    }, (error, data) => error ? reject(error) : resolve(data)));
    const presentation = "ppt/presentation.xml";
    const deckLinks = relations(files, "ppt/_rels/presentation.xml.rels", presentation);
    const ordered = elements(xml(files[presentation]), "sldId").map(node => deckLinks.get(attribute(node, "id")));
    const slides = (ordered.length ? ordered : Object.keys(files).sort((a,b) => a.localeCompare(b, undefined, { numeric: true })))
      .filter(path => path && slidePath.test(path) && files[path]);
    if (!slides.length) throw new Error("No slides were found.");
    if (slides.length > 60) throw new Error("Split this deck into files of 60 slides or fewer.");
    const parts = [];
    for (const path of slides) {
      const slide = xml(files[path]);
      const paragraphs = elements(slide, "p").map(node =>
        elements(node, "t").filter(text => text.namespaceURI === node.namespaceURI).map(text => text.textContent).join("").trim()
      ).filter(Boolean);
      if (paragraphs.length) {
        parts.push(...paragraphs);
        continue;
      }
      const relPath = path.replace(/([^/]+)$/, "_rels/$1.rels");
      const links = relations(files, relPath, path);
      const images = new Set(elements(slide, "blip").map(node => links.get(attribute(node, "embed"))).filter(name => name && mediaPath.test(name) && files[name]));
      for (const name of images) parts.push(await recognize(new Blob([files[name]])));
    }
    return parts;
  }

  async function photoForOcr(blob) {
    const bitmap = await createImageBitmap(blob);
    try {
      const scale = Math.min(1.8, 2200 / Math.max(bitmap.width, bitmap.height));
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      const ctx = canvas.getContext("2d", { alpha: false });
      ctx.fillStyle = "#fff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise((resolve,reject) => canvas.toBlob(value => value ? resolve(value) : reject(new Error("The photo could not be prepared.")), "image/png"));
    } finally {
      bitmap.close();
    }
  }

  function recognizedParagraphs(data) {
    if (!data.blocks?.length) return data.text;
    const sections = [];
    for (const block of data.blocks) {
      for (const paragraph of block.paragraphs || []) {
        let lines = [];
        for (const line of paragraph.lines || []) {
          const text = line.text.trim();
          if (!text || line.confidence < 55) {
            if (lines.length) sections.push(lines.join(" "));
            lines = [];
          } else {
            lines.push(text);
          }
        }
        if (lines.length) sections.push(lines.join(" "));
      }
    }
    return sections.join("\n");
  }

  function chunks(part) {
    const clean = part.normalize("NFKC").replace(/(\p{Script=Han})[ \t]+(?=\p{Script=Han})/gu, "$1");
    return clean.split(/(?<=[。！？.!?；;])\s*|\n+/u)
      .map(source => source.replace(/\s+/gu, " ").trim())
      .filter(source => source.length >= 7 && source.length <= 176);
  }

  function tokens(sentence) {
    return [...segmenter.segment(sentence)].filter(({ segment, isWordLike }) =>
      isWordLike && (chinese.test(segment) ? /^\p{Script=Han}{2,9}$/u.test(segment) : /^[A-Za-z][A-Za-z'-]{3,24}$/u.test(segment)) &&
      !ignored.has(segment.toLowerCase())
    );
  }

  function draftQuestions(parts, count) {
    const sources = [...new Set(parts.flatMap(chunks))].slice(0, 1200);
    const segments = sources.map(source => ({ source, words: tokens(source) }));
    const termPool = [...new Set(segments.flatMap(({ words }) => words.map(word => word.segment)))];
    const questions = [];
    const used = new Set();
    for (const { source, words } of segments) {
      for (const { segment, index } of [...words].sort((a,b) => b.segment.length - a.segment.length)) {
        const key = segment.toLowerCase();
        if (used.has(key) || source.toLowerCase().indexOf(key) !== source.toLowerCase().lastIndexOf(key)) continue;
        const sameLanguage = candidate => chinese.test(candidate) === chinese.test(segment);
        const sourceLower = source.toLowerCase();
        const alternatives = termPool.filter(candidate => sameLanguage(candidate) && !sourceLower.includes(candidate.toLowerCase()) &&
          !candidate.toLowerCase().includes(key) && !key.includes(candidate.toLowerCase()));
        alternatives.sort((a,b) => Math.abs(a.length - segment.length) - Math.abs(b.length - segment.length));
        const options = [];
        const distinct = new Set();
        for (const candidate of alternatives) {
          if (distinct.has(candidate.toLowerCase())) continue;
          distinct.add(candidate.toLowerCase());
          options.push(candidate);
          if (options.length === 3) break;
        }
        if (options.length < 3) continue;
        const correct = questions.length % 4;
        options.splice(correct, 0, segment);
        const blank = source.slice(0,index) + "____" + source.slice(index + segment.length);
        const isChinese = chinese.test(source);
        const prompt = (isChinese ? "根据资料，补全原句。\n" : "Complete the sentence from the material.\n") + blank;
        const explanation = (isChinese ? "资料中的原句为\n" : "The original sentence reads\n") + source;
        questions.push([prompt, options, correct, explanation, 25, null]);
        used.add(key);
        break;
      }
      if (questions.length >= count) break;
    }
    return questions;
  }

  async function generate(files, count, progress) {
    if (!files.length || files.length > maxFiles) throw new Error("Choose 1–10 PowerPoint files or photos.");
    if (files.some(file => file.size > maxFileBytes) || files.reduce((sum,file) => sum + file.size, 0) > maxBatchBytes) {
      throw new Error("Use files up to 25 MB each and 60 MB total.");
    }
    let engine;
    async function recognize(blob) {
      if (!engine) {
        progress("Loading Chinese and English photo recognition…");
        const tesseract = await loadVendor("Tesseract", "tesseract.min.js");
        engine = await tesseract.createWorker(["chi_sim", "eng"], 1, {
          workerBlobURL: false,
          workerPath: vendor("worker.min.js"),
          corePath: vendor("tesseract-core-lstm.wasm.js"),
          langPath: vendor(".").replace(/\/$/, ""),
          gzip: true,
          cacheMethod: "none"
        });
      }
      progress("Reading text in a photo…");
      const { data } = await engine.recognize(await photoForOcr(blob), {}, { text: true, blocks: true });
      return recognizedParagraphs(data);
    }
    const parts = [];
    const failed = [];
    try {
      for (const [index, file] of files.entries()) {
        progress("Reading file " + (index + 1) + " of " + files.length + "…");
        try {
          if (/\.pptx$/i.test(file.name)) parts.push(...await readSlides(file, recognize));
          else if (imageExtension.test(file.name)) parts.push(await recognize(file));
          else throw new Error("Use PPTX, JPG, PNG, or WebP.");
        } catch (error) {
          failed.push(file.name + " (" + error.message + ")");
        }
      }
    } finally {
      if (engine) await engine.terminate();
    }
    const questions = draftQuestions(parts, count);
    if (!questions.length) throw new Error("There isn’t enough readable text to create four-choice questions." +
      (failed.length ? " Files to check: " + failed.join(", ") : " Try a clearer photo or a deck with more text."));
    return { questions, failed };
  }

  window.QuizPopImport = { generate };
})();

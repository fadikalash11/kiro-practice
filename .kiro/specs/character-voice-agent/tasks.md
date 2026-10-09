# Implementation Plan: Character Voice Agent (المراحل الأساسية 1-5)

كل مهمة تُنفَّذ وتُختبر بالمتصفح قبل الانتقال للتالية. المسارات نسبية لجذر المشروع `kiro-hackathon/`.

- [x] 1. إعداد المشروع وخادم FastAPI الأساسي
  - التأكد من توفّر `uv` و Python 3.12+ (تثبيتهما إن لزم).
  - نسخ `.env` من المجلد الأب `../.env` إلى `kiro-hackathon/.env`.
  - إنشاء `pyproject.toml` يعلن: `fastapi`, `uvicorn[standard]`, `python-dotenv`, `boto3`, `langgraph`, `langchain-aws` (Python 3.12+).
  - إنشaء `main.py`: `load_dotenv()` بأمان (لا يفشل بدون `.env`)، `app = FastAPI()`، `GET /health` يرجع `{"status":"ok"}`، وتقديم `public/` كملفات ثابتة (StaticFiles / endpoints للـ avatars/animations/music).
  - تشغيل `uv sync`.
  - _اختبار:_ `uv run uvicorn main:app --reload` يعمل، و`GET /health` يرد 200، و`http://localhost:8000` يفتح.
  - _Requirements: 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7_

- [x] 2. المرحلة 1 — الشخصية تظهر
- [x] 2.1 الهيكل الأساسي للواجهة وتحميل VRM
  - إنشاء `public/index.html` مع import map (three 0.186.1, three/addons, @pixiv/three-vrm 3.5.5) وحاوية canvas وشاشة "Click to start".
  - إنشاء `public/app.js`: مشهد three.js، كاميرا `PerspectiveCamera(30, aspect, 0.1, 20)` عند `(0,1.0,4.0)` تنظر إلى `(0,0.75,0)`، renderer بـ `alpha:true`.
  - تحميل `CoolAlien.vrm` عبر `GLTFLoader` + `VRMLoaderPlugin`، تطبيق `VRMUtils.rotateVRM0`، ضبط `frustumCulled=false` على كل الكائنات.
  - حلقة الرسم: `mixer.update(delta)` ثم `vrm.update(delta)` ثم `render`.
  - _اختبار:_ الكائن الفضائي يظهر كامل الجسم يواجه الكاميرا (ليس T-pose) على خلفية ملوّنة.
  - _Requirements: 1.2, 1.3, 1.4, 1.5_

- [x] 2.2 محمّل حركات Mixamo (retargeting)
  - إنشاء `public/loadMixamoAnimation.js`: `FBXLoader`، إيجاد الكليب `AnimationClip.findByName(fbx.animations, "mixamo.com")`.
  - تطبيق جدول عظام Mixamo→VRM من `REQUIREMENTS.md`، جلب العقد بـ `vrm.humanoid.getNormalizedBoneNode(name)`، تخطّي المجهولة.
  - تطبيق معادلة الدوران `P × q × R⁻¹`، وعكس x/z لـ VRM 0.x، وقياس موضع الوركين، وتسمية المسارات `<vrmNode.name>.<property>`.
  - _اختبار:_ تحميل `idle` وتشغيله يحرّك الشخصية طبيعياً دون تشوّه.
  - _Requirements: 1.9_

- [x] 2.3 idle + رمش + مقدّمة Click to start
  - تشغيل `idle` في حلقة بعد التحميل.
  - مؤقّت رمش كل بضع ثوانٍ عبر `expressionManager.setValue("blink", ...)`.
  - عند النقر على "Click to start": تشغيل `fall-flat` ثم `stand-up` (`LoopOnce`+`clampWhenFinished`، انتظار حدث `finished`؛ `stand-up` يتخطّى ~2.5s ويعمل 1.6×) ثم العودة إلى `idle` بـ crossfades.
  - _اختبار:_ الشخصية تتنفس وترمش؛ بعد النقر تسقط ثم تنهض ثم تعود idle.
  - _Requirements: 1.1, 1.6, 1.7, 1.8_

- [x] 3. المرحلة 2 — الشخصية تفكّر (رد نصّي)
- [x] 3.1 الـ agent والـ WebSocket على الخادم
  - إنشaء `character.json` مبدئي (name, avatar=/avatars/CoolAlien.vrm, voice, personality, greeting, background) — تُثرى في المرحلة 5.
  - تعريف نموذج `Reply` (Pydantic): `text: str` (و`emotion` تُضاف في المرحلة 4).
  - بناء LangGraph: `StateGraph` فوق `MessagesState` + `InMemorySaver`، عقدة `call_model` تستخدم `ChatBedrockConverse(model="us.amazon.nova-lite-v1:0", region_name="us-east-1").with_structured_output(Reply)`.
  - system prompt يحقن `name`+`personality` من `character.json` وقيود الأسلوب (1-3 جمل، بدون قوائم/emojis).
  - endpoint `WS /ws`: `thread_id=uuid4` لكل اتصال، استقبال `{type:"user_message", text}`، استدعاء الـ agent، إرسال `{type:"reply", text}`؛ عند الفشل `{type:"error", message}`.
  - `GET /character` يرجع character.json **بدون** `personality`.
  - _اختبار:_ إرسال رسالة عبر WS يرجع رداً نصّياً بالشخصية؛ المحادثة تُتذكّر.
  - _Requirements: 2.2, 2.3, 2.4, 2.5, 2.6, 5.2_

- [x] 3.2 واجهة الدردشة النصّية
  - صندوق نص + زر Send في `index.html`؛ Enter يرسل.
  - فتح WebSocket `/ws` عند التحميل؛ إرسال رسالة المستخدم؛ عرض الرد في الصفحة.
  - تعطيل Send أثناء انتظار الرد (رد واحد في كل مرة)؛ قص الرسالة إلى 500 حرف؛ عند `error` عرض رسالة ودّية وإعادة تفعيل Send.
  - _اختبار:_ الكتابة تعطي رداً بالشخصية، Send معطّل أثناء الانتظار، الرسائل الطويلة تُقص، الخطأ يظهر ودّياً.
  - _Requirements: 2.1, 2.7, 2.8, 2.9_

- [x] 4. المرحلة 3 — الشخصية تتكلّم (صوت + lip sync)
- [x] 4.1 تكامل Polly على الخادم
  - التحقق من صلاحية Polly باستدعاء `synthesize_speech` اختباري.
  - لكل رد: استدعاء Polly مرتين بالتوازي (threads): `mp3`+`neural`+`VoiceId` من character.json، و`json`+`SpeechMarkTypes=["viseme","word"]`.
  - تضمين الـ mp3 base64 وقائمة `visemes` (`{time,value}`) في رسالة `{type:"reply"}`.
  - _اختبار:_ رسالة WS ترجع `audio` base64 و`visemes` غير فارغة.
  - _Requirements: 3.1, 3.2_

- [x] 4.2 تشغيل الصوت و lip sync في المتصفح
  - `AudioContext` واحد مع `resume()` بعد أول نقرة؛ `decodeAudioData` ثم `AudioBufferSourceNode`.
  - lip sync كل إطار: `now = (currentTime - startTime - outputLatency)×1000`، آخر viseme بـ `time≤now`، ضبط `aa/ih/ou/ee/oh` حسب جدول design.md (الباقي 0).
  - فقاعة كلام تعرض النص عند بدء الصوت وتختفي عند انتهائه.
  - _اختبار:_ الرد يُسمع بصوت Polly، الفم متزامن، الفقاعة تظهر ثم تختفي.
  - _Requirements: 3.3, 3.4, 3.5_

- [x] 5. المرحلة 4 — الشخصية تشعر وتتحرّك
- [x] 5.1 المشاعر وآلة حالة الحركات
  - توسيع `Reply` ليشمل `emotion: Literal["neutral","happy","angry","sad","relaxed"]`؛ تضمينه في رسالة الرد.
  - في المتصفح: `expressionManager.setValue(emotion, ~0.7)` أثناء الكلام، والعودة إلى 0 بعده.
  - آلة حالة الحركات: `thinking` أثناء انتظار الرد، `talking` أثناء الكلام، `idle` خلاف ذلك، بانتقالات `crossFadeTo(next, 0.4)`.
  - _اختبار:_ المشاعر تظهر على الوجه أثناء الكلام؛ الحركات تتبدّل thinking/talking/idle بسلاسة.
  - _Requirements: 4.1, 4.2, 4.3, 4.4_

- [x] 5.2 زر الرقص
  - زر "Dance" في الواجهة؛ عند الضغط: تشغيل `dance` في حلقة مع `music/dance.mp3`.
  - عند الضغط ثانية أو إرسال رسالة: إيقاف الرقص والعودة للحالة المناسبة.
  - _اختبار:_ زر Dance يشغّل الرقص مع الموسيقى؛ الضغط ثانية/إرسال رسالة يوقفه.
  - _Requirements: 4.5, 4.6_

- [x] 6. المرحلة 5 — الشخصية صارت لك (تخصيص)
  - إثراء `character.json`: اسم فضائي مميّز، `personality` غنية، `greeting`، صوت Polly (مثل Matthew)، لونا `background`.
  - تطبيق ألوان `background` كتدرّج خلفية CSS عند التحميل.
  - بعد "Click to start" والمقدّمة: نطق جملة `greeting` بمسار Polly (صوت + lip sync).
  - التأكد أن الصوت المستخدم في Polly يأتي من `character.json`.
  - _اختبار:_ عند البدء تُسمع جملة الترحيب؛ الاسم/الشخصية/الصوت/الألوان مخصّصة.
  - _Requirements: 5.1, 5.3, 5.4, 5.5_

- [x] 7. تأكيد نهائي وتنظيف
  - التأكد أن التطبيق يبدأ **بدون** `.env` (محاكاة بيئة الخادم) دون فشل عند الإقلاع.
  - مراجعة عدم طباعة/إرسال أي مفاتيح للمتصفح وبقاء `personality` على الخادم.
  - اختبار متسلسل كامل للمراحل 1-5 في المتصفح.
  - _Requirements: 0.6, 0.8, 2.4_

# Requirements: Character Voice Agent (المراحل الأساسية 1-5)

## المقدمة (Introduction)

تطبيق ويب يعرض شخصية 3D (👽 `CoolAlien.vrm`) تتحدث مع المستخدم. يكتب المستخدم رسالة فيرد الـ agent بشخصيته عبر Amazon Nova Lite، ثم يُنطَق الرد صوتياً عبر Amazon Polly مع تحريك الشفاه (lip sync)، وتظهر المشاعر على الوجه وتتبدّل الحركات حسب الحالة.

هذه الوثيقة تغطّي **المراحل الأساسية 1-5 فقط**. البونصات (A/B/C/D) خارج النطاق. النطاق التقني محكوم بـ `REQUIREMENTS.md` و `design.md` في هذا الـ spec.

الموديل المؤكّد: Amazon Nova Lite (`us.amazon.nova-lite-v1:0`, region `us-east-1`). الأصول موجودة في `public/`.

---

## المتطلبات (Requirements)

### Requirement 0: إعداد المشروع والخادم الأساسي

**User Story:** كمطوّر، أريد مشروع Python مُهيّأ بـ `uv` وخادم FastAPI يعمل، حتى أبني عليه بقية الميزات.

#### Acceptance Criteria

1. WHEN يُنشأ المشروع THEN SHALL يحوي `pyproject.toml` يعلن التبعيّات: `fastapi`, `uvicorn[standard]`, `python-dotenv`, `boto3`, `langgraph`, `langchain-aws` على Python 3.12+.
2. WHEN يُشغَّل `uv sync` THEN SHALL تُثبّت كل التبعيّات دون أخطاء.
3. WHEN يُشغَّل `uv run uvicorn main:app --reload` THEN SHALL يبدأ الخادم على `http://localhost:8000` دون أخطاء.
4. WHEN يُطلب `GET /health` THEN SHALL يُرجع الخادم `{"status":"ok"}` برمز 200.
5. THE main.py SHALL يعرّف `app = FastAPI()` في جذر المشروع ويقدّم ملفات `public/` كملفات ثابتة.
6. WHEN يوجد ملف `.env` THEN SHALL يُحمَّل عبر `python-dotenv`؛ AND WHEN لا يوجد `.env` THEN SHALL يبدأ الخادم دون فشل (معتمداً على بيئة AWS الخارجية).
7. THE كل عملاء boto3 و `ChatBedrockConverse` SHALL يُمرَّر لهم `region_name="us-east-1"` صراحةً.
8. THE الخادم SHALL لا يطبع ولا يرسل مفاتيح AWS إلى المتصفح أبداً.

---

### Requirement 1 (Milestone 1): الشخصية تظهر

**User Story:** كمستخدم، أريد رؤية الشخصية الفضائية حيّة على الصفحة، حتى أشعر أنها حاضرة قبل أن أتحدث إليها.

#### Acceptance Criteria

1. WHEN تُفتح الصفحة THEN SHALL تُعرض شاشة "Click to start" أولاً (لأن المتصفحات تحجب الصوت قبل التفاعل).
2. WHEN تُحمَّل الصفحة THEN SHALL يُحمَّل `CoolAlien.vrm` عبر `GLTFLoader` مع `VRMLoaderPlugin`، ويُطبَّق `VRMUtils.rotateVRM0(vrm)`، ويُضبط `frustumCulled = false` على كل كائناته.
3. THE الكاميرا SHALL تكون `PerspectiveCamera(30, aspect, 0.1, 20)` عند `(0, 1.0, 4.0)` تنظر إلى `(0, 0.75, 0)`، AND THE renderer SHALL يُفعّل `alpha: true` ليظهر لون خلفية CSS.
4. WHEN يُعرض المشهد THEN SHALL تظهر الشخصية كامل الجسم تواجه الكاميرا (ليست في وضع T-pose ولا تواجه بعيداً).
5. THE حلقة الرسم SHALL تستدعي في كل إطار `mixer.update(delta)` ثم `vrm.update(delta)` ثم `render`.
6. WHILE الصفحة مفتوحة THE الشخصية SHALL تشغّل حركة `idle` في حلقة AND SHALL ترمش كل بضع ثوانٍ عبر `expressionManager`.
7. WHEN ينقر المستخدم "Click to start" THEN SHALL تُشغَّل مقدّمة بالترتيب: `fall-flat` ثم `stand-up` ثم العودة إلى `idle`، كل انتقال بـ crossfade.
8. WHEN تُشغَّل `fall-flat` و `stand-up` THEN SHALL تُشغَّلا بـ `LoopOnce` و `clampWhenFinished` مع انتظار حدث `finished`؛ AND THE `stand-up` SHALL تتخطّى ~2.5 ثانية وتُشغَّل بسرعة 1.6×.
9. WHERE تُحمَّل حركة Mixamo (FBX) على VRM THE النظام SHALL يعيد التوجيه (retargeting) حسب جدول العظام ومعادلات الـ quaternion في `REQUIREMENTS.md` (بما فيها عكس x/z لـ VRM 0.x وقياس موضع الوركين)، AND SHALL يتخطّى العظام المجهولة.

---

### Requirement 2 (Milestone 2): الشخصية تفكّر (رد نصّي)

**User Story:** كمستخدم، أريد كتابة رسالة وتلقّي رد نصّي بشخصية الكاركتر، حتى أتحادث معها.

#### Acceptance Criteria

1. THE الواجهة SHALL تعرض صندوق نص وزر "Send"، AND WHEN يضغط المستخدم Enter THEN SHALL تُرسَل الرسالة.
2. WHEN تُرسَل رسالة THEN SHALL تُنقل عبر WebSocket `/ws` كرسالة JSON `{type:"user_message", text}`.
3. WHEN يستقبل الخادم رسالة THEN SHALL يستدعي LangGraph agent يعتمد `ChatBedrockConverse` (Nova Lite، `us-east-1`) مع `with_structured_output(Reply)` AND SHALL يرد برسالة JSON تحوي `text`.
4. THE system prompt SHALL يحقن `personality` و `name` من `character.json`، AND THE `personality` SHALL تبقى على الخادم ولا تُرسَل للمتصفح.
5. THE الردود SHALL تكون قصيرة (1-3 جمل) دون قوائم أو emojis.
6. WHILE الصفحة مفتوحة THE الـ agent SHALL يتذكّر المحادثة عبر `StateGraph`/`MessagesState` مع `InMemorySaver` و `thread_id` واحد لكل اتصال WebSocket، محتفظاً بآخر ~20 رسالة.
7. WHILE ينتظر النظام رداً THE زر "Send" SHALL يكون معطّلاً (رد واحد في كل مرة).
8. WHEN تتجاوز الرسالة 500 حرف THEN SHALL تُقص إلى 500 حرف قبل الإرسال.
9. IF فشل توليد الرد THEN SHALL يرسل الخادم `{type:"error", message}` AND SHALL تعرض الواجهة رسالة خطأ قصيرة ودّية وتعيد تفعيل "Send" للمحاولة ثانية.

---

### Requirement 3 (Milestone 3): الشخصية تتكلّم (صوت + lip sync)

**User Story:** كمستخدم، أريد سماع الرد بصوت الشخصية مع تحريك الفم، حتى تبدو وكأنها تتكلّم فعلاً.

#### Acceptance Criteria

1. WHEN يُولَّد رد THEN SHALL يستدعي الخادم Amazon Polly `synthesize_speech` **مرتين بالتوازي**: واحدة `OutputFormat="mp3"` و `Engine="neural"` و `VoiceId` من `character.json`، وأخرى `OutputFormat="json"` مع `SpeechMarkTypes=["viseme","word"]`.
2. WHEN يُرسَل الرد THEN SHALL يحوي الـ mp3 بترميز base64 وقائمة الـ visemes (كل عنصر `{time(ms), value}`).
3. WHEN يصل الصوت للمتصفح THEN SHALL يُشغَّل عبر `AudioContext` واحد (مع `resume()` بعد أول نقرة)، باستخدام `decodeAudioData` ثم `AudioBufferSourceNode`.
4. WHILE يُشغَّل الصوت THE الفم SHALL يتزامن معه: في كل إطار يُحسب `now = (currentTime - startTime - outputLatency) × 1000`، ويُؤخذ آخر viseme بـ `time ≤ now`، وتُضبط أشكال الفم (`aa/ih/ou/ee/oh`) حسب جدول التحويل في `design.md` (الباقي 0).
5. WHILE تتكلّم الشخصية THE فقاعة كلام SHALL تعرض نص الرد، AND WHEN ينتهي الصوت THEN SHALL تختفي الفقاعة.

---

### Requirement 4 (Milestone 4): الشخصية تشعر وتتحرّك

**User Story:** كمستخدم، أريد أن تُظهر الشخصية مشاعر وتتحرّك حسب الحالة وترقص عند الطلب، حتى تبدو حيّة ومعبّرة.

#### Acceptance Criteria

1. THE نموذج `Reply` SHALL يحوي حقل `emotion` من `Literal["neutral","happy","angry","sad","relaxed"]` يختاره الـ AI لكل رد.
2. WHILE تتكلّم الشخصية THE الوجه SHALL يُظهر المشاعر عبر `expressionManager.setValue(emotion, ~0.7)`، AND WHEN ينتهي الكلام THEN SHALL تعود القيمة إلى 0.
3. THE النظام SHALL يبدّل الحركات حسب الحالة: `thinking` أثناء انتظار الرد، `talking` أثناء الكلام، `idle` خلاف ذلك.
4. WHEN تتبدّل الحركة THEN SHALL يكون الانتقال بـ `crossFadeTo(next, 0.4)` (crossfade ناعم).
5. THE الواجهة SHALL تعرض زر "Dance"، AND WHEN يُضغط THEN SHALL تُشغَّل حركة `dance` في حلقة مع `music/dance.mp3`.
6. WHEN يُضغط "Dance" ثانية OR تُرسَل رسالة جديدة THEN SHALL يتوقّف الرقص وتعود الشخصية للحالة المناسبة.

---

### Requirement 5 (Milestone 5): الشخصية صارت لك (تخصيص)

**User Story:** كمستخدم، أريد شخصية ذات اسم وطبع وصوت وألوان وترحيب خاص بها، حتى تكون فريدة.

#### Acceptance Criteria

1. THE ملف `character.json` SHALL يحوي: `name`, `avatar` (`/avatars/CoolAlien.vrm`), `voice` (معرّف صوت Polly + engine `neural`), `personality`, `greeting`, `background` (لونان).
2. WHEN يُطلب `GET /character` THEN SHALL يُرجع الخادم محتوى `character.json` **بدون** حقل `personality`.
3. WHEN تُحمَّل الصفحة THEN SHALL تُطبَّق ألوان `background` كتدرّج خلفية CSS، AND SHALL يُستخدم `voice` المحدّد في نداءات Polly.
4. WHEN ينقر المستخدم "Click to start" (بعد المقدّمة) THEN SHALL تنطق الشخصية جملة الـ `greeting` بنفس مسار Polly (صوت + lip sync).
5. THE الشخصية SHALL تملك `name` و `personality` و `greeting` مخصّصة (ليست القيم الافتراضية الفارغة).

---

## خارج النطاق (Out of Scope)

- **Bonus A:** المايك + Amazon Transcribe streaming.
- **Bonus B:** `moves` واختيار الـ AI للحركة.
- **Bonus C:** أدوات يستدعيها الـ AI، تأثيرات، حركات/أفاتار جديدة.
- **Bonus D:** النشر على الخادم (aws configure منجز؛ المتبقي fork + push + deploy).

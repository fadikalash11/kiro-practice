# Design: Character Voice Agent (المراحل الأساسية 1-5)

## نظرة عامة (Overview)

تطبيق ويب يعرض شخصية 3D (👽 `CoolAlien.vrm`) تتحدث مع المستخدم. المستخدم يكتب رسالة، فيرد عليها الـ agent بشخصيته عبر Amazon Nova Lite، ثم يُنطَق الرد صوتياً عبر Amazon Polly مع تحريك الشفاه (lip sync)، وتظهر المشاعر على الوجه وتتبدّل الحركات حسب الحالة.

هذا التصميم يغطي **المراحل الأساسية 1-5 فقط**. البونصات (A: المايك/Transcribe، B: الحركات الذكية، C: الأدوات/التأثيرات، D: النشر) خارج النطاق وتُضاف لاحقاً.

النطاق التقني محكوم بالكامل بملف `REQUIREMENTS.md` الموجود في جذر المشروع، خصوصاً قسم "Technical notes" الذي يحوي حلولاً مجرّبة للأجزاء الصعبة. هذا التصميم يلتزم به حرفياً.

### حقائق مؤكّدة (لا تُعاد مراجعتها)
- AWS CLI مضبوط (region `us-east-1`, output `json`) والمفاتيح تعمل (نجح `sts get-caller-identity` للمستخدم `sync-p06`).
- **Nova Lite يعمل**: `us.amazon.nova-lite-v1:0` في `us-east-1` نجح استدعاؤه. باقي الموديلات إما منتهية أو ممنوعة لهذا المستخدم — Nova Lite هو الموديل الوحيد المؤكّد.
- الـ assets موجودة في `public/`: `CoolAlien.vrm`, `CoolPineapple.vrm`؛ الحركات `idle/thinking/talking/dance/fall-flat/stand-up.fbx`؛ `music/dance.mp3`.
- `.gitignore` يحمي `.env`. يوجد `.env` بالمفاتيح في المجلد الأب `/home/fadikalash/Desktop/hackthon Agentic /.env` ويجب نسخه داخل `kiro-hackathon/`.
- Polly لم يُختبر بعد — يُختبر في المرحلة 3.

---

## المعمارية (Architecture)

```
┌─────────────────────────────────────────────────────────────┐
│                      المتصفح (Browser)                        │
│                                                               │
│  index.html (import map)                                      │
│  ├── three 0.186.1  +  @pixiv/three-vrm 3.5.5  (CDN)          │
│  └── app.js                                                   │
│       ├── مشهد 3D: VRM + كاميرا + حلقة رسم                     │
│       ├── loadMixamoAnimation.js (retargeting)               │
│       ├── آلة حالات الحركات (idle/thinking/talking/dance)     │
│       ├── lip sync (visemes → فم)  +  رمش                     │
│       ├── AudioContext (تشغيل mp3)                            │
│       └── واجهة: صندوق نص، زر Send، فقاعة كلام، زر Dance      │
└───────────────────────────┬───────────────────────────────────┘
                            │  WebSocket /ws  (رسائل JSON)
                            ▼
┌─────────────────────────────────────────────────────────────┐
│                   السيرفر (main.py — FastAPI)                 │
│                                                               │
│  ├── GET /            → public/index.html                    │
│  ├── GET /character   → character.json (بدون personality)    │
│  ├── GET /health      → {"status":"ok"}                      │
│  ├── StaticFiles      → public/* (avatars, animations, music)│
│  └── WS /ws           → agent + Polly                        │
│                                                               │
│  ├── LangGraph agent  →  ChatBedrockConverse (Nova Lite)      │
│  │     with_structured_output(Reply) → text + emotion        │
│  │     ذاكرة: StateGraph/MessagesState + InMemorySaver        │
│  └── Polly: synthesize_speech ×2 متوازي (mp3 + visemes)      │
└───────────────────────────┬───────────────────────────────────┘
                            │  boto3 (region=us-east-1)
                            ▼
              ┌──────────────────┐   ┌──────────────────┐
              │  Amazon Bedrock  │   │   Amazon Polly   │
              │   (Nova Lite)    │   │   (neural)       │
              └──────────────────┘   └──────────────────┘
```

### تخطيط الملفات (File Layout)
```
kiro-hackathon/
├── .env                      # يُنسخ من المجلد الأب (git-ignored)
├── .env.example              # موجود
├── pyproject.toml            # تبعيّات uv (جديد)
├── main.py                   # FastAPI app (جديد)
├── character.json            # إعدادات الشخصية (جديد)
├── REQUIREMENTS.md           # موجود (مرجع)
├── README.md                 # موجود
└── public/
    ├── index.html            # الواجهة + import map (جديد)
    ├── app.js                # منطق الواجهة الرئيسي (جديد)
    ├── loadMixamoAnimation.js# محمّل/retargeting حركات Mixamo (جديد)
    ├── avatars/CoolAlien.vrm # موجود
    ├── animations/*.fbx      # موجودة (6 ملفات)
    └── music/dance.mp3       # موجود
```

---

## المكوّنات والواجهات (Components and Interfaces)

### 1. السيرفر — `main.py`

**تحميل البيئة بأمان (يعمل مع/بدون `.env`):**
```python
from dotenv import load_dotenv
load_dotenv()  # إن لم يوجد .env لا يفشل؛ على السيرفر يُستخدم IAM role
```
جميع عملاء boto3 و `ChatBedrockConverse` يأخذون `region_name="us-east-1"` صراحةً (boto3 لا يقرأ `AWS_REGION` دائماً).

**نقاط النهاية (Endpoints):**
| المسار | النوع | الوظيفة |
|--------|-------|---------|
| `GET /health` | HTTP | `{"status":"ok"}` — فحص جاهزية (Task 1) |
| `GET /` | HTTP | يُرجع `public/index.html` |
| `GET /character` | HTTP | يُرجع `character.json` **بدون** حقل `personality` (يبقى على السيرفر) |
| `/avatars`, `/animations`, `/music` | StaticFiles | ملفات الـ assets |
| `WS /ws` | WebSocket | قناة المحادثة (رسائل JSON) |

ملاحظة: الـ `personality` تُقرأ على السيرفر فقط وتُحقن في الـ system prompt؛ لا تُرسَل للمتصفح أبداً.

### 2. نموذج الرد (Reply) — Pydantic

```python
from typing import Literal
from pydantic import BaseModel

class Reply(BaseModel):
    text: str                                                    # 1-3 جمل، بدون قوائم/emojis
    emotion: Literal["neutral","happy","angry","sad","relaxed"]  # تُضاف فعلياً في المرحلة 4
```
في المرحلة 2 يُستخدم `text` فقط عملياً؛ حقل `emotion` يُفعّل عرضه في المرحلة 4 (نفس النموذج). حقل `move` للبونص B خارج النطاق.

### 3. الـ LangGraph agent

- `ChatBedrockConverse(model="us.amazon.nova-lite-v1:0", region_name="us-east-1").with_structured_output(Reply)`.
- الذاكرة: `StateGraph` فوق `MessagesState` مع `InMemorySaver` checkpointer.
- **`thread_id` واحد لكل اتصال WebSocket** (يُولّد عند فتح الاتصال، مثلاً `uuid4`).
- يُحتفظ بآخر ~20 رسالة لكل thread.
- **system prompt** يحقن `personality` + `name` + قيود الأسلوب (ردود قصيرة 1-3 جمل، بدون قوائم أو emojis، بشخصية الكاركتر).

رسم الـ graph (بسيط، عقدة واحدة للنموذج):
```
START → call_model(structured Reply) → END
```
(لا نستخدم حلقة bind_tools في النطاق الأساسي — الأدوات للبونص C.)

### 4. تدفّق Polly (المرحلة 3)

لكل رد، نستدعي `synthesize_speech` **مرتين بالتوازي** عبر threads (`concurrent.futures.ThreadPoolExecutor` أو `asyncio.to_thread`):
1. `OutputFormat="mp3"`, `Engine="neural"`, `VoiceId=<من character.json>` → صوت.
2. `OutputFormat="json"`, `SpeechMarkTypes=["viseme","word"]` → توقيتات (كائن JSON في كل سطر؛ `time` بالملي ثانية).

يُرسَل الـ mp3 كـ base64 مع قائمة الـ visemes عبر WebSocket.

### 5. بروتوكول رسائل WebSocket (JSON)

**المتصفح → السيرفر:**
```json
{ "type": "user_message", "text": "<حتى 500 حرف>" }
```

**السيرفر → المتصفح (الرد):**
```json
{
  "type": "reply",
  "text": "نص الرد",
  "emotion": "happy",
  "audio": "<mp3 base64>",
  "visemes": [ { "time": 0, "value": "a" }, { "time": 120, "value": "p" } ]
}
```
> المرحلة 2: `text` فقط. المرحلة 3: يُضاف `audio` + `visemes`. المرحلة 4: يُستخدم `emotion`.

**السيرفر → المتصفح (خطأ):**
```json
{ "type": "error", "message": "رسالة ودّية قصيرة" }
```
عند الخطأ يُعاد تفعيل زر Send ليعيد المستخدم المحاولة.

### 6. الواجهة الأمامية — `public/app.js`

**إعداد المشهد (من Technical notes حرفياً):**
- `GLTFLoader` مع `.register(parser => new VRMLoaderPlugin(parser))`؛ الـ avatar هو `gltf.userData.vrm`.
- `VRMUtils.rotateVRM0(vrm)` (وإلا يواجه بعيداً)، و `frustumCulled = false` على كل كائناته.
- كاميرا: `PerspectiveCamera(30, aspect, 0.1, 20)` عند `(0, 1.0, 4.0)` تنظر إلى `(0, 0.75, 0)`.
- renderer بـ `alpha: true` ليظهر لون خلفية CSS.
- **كل إطار:** `mixer.update(delta)` ثم `vrm.update(delta)` ثم `render`.

**محمّل حركات Mixamo — `loadMixamoAnimation.js` (أصعب جزء):**
نتبع نفس طريقة مثال three-vrm الرسمي "humanoidAnimation":
1. `FBXLoader`؛ الكليب = `AnimationClip.findByName(fbx.animations, "mixamo.com")`.
2. كل مسار اسمه `mixamorigBone.property`؛ نحوّل اسم العظم عبر جدول العظام ونجلب عقدة VRM بـ `vrm.humanoid.getNormalizedBoneNode(name)`؛ نتخطّى العظام المجهولة.
3. الدورانات: مع `R` = دوران العظم Mixamo في وضع الراحة (world) و `P` = دوران الأب، كل keyframe `q` يصبح `P × q × R⁻¹`.
4. VRM 0.x (`vrm.meta.metaVersion === "0"`): نعكس إشارة x و z لكل quaternion، ولموضع الوركين (hips).
5. موضع الوركين: نضربه بـ `vrmHipsHeight / mixamoHipsHeight`.
6. نسمّي المسارات `<vrmNode.name>.<property>`؛ نشغّلها بـ `AnimationMixer` على `vrm.scene`؛ نبدّل الكليبات بـ `crossFadeTo(next, 0.4)`.

جدول العظام (من REQUIREMENTS.md): `Hips→hips, Spine→spine, Spine1→chest, Spine2→upperChest, Neck→neck, Head→head, LeftShoulder→leftShoulder, LeftArm→leftUpperArm, LeftForeArm→leftLowerArm, LeftHand→leftHand, LeftUpLeg→leftUpperLeg, LeftLeg→leftLowerLeg, LeftFoot→leftFoot, LeftToeBase→leftToes` (و Right بالمثل، كلها ببادئة `mixamorig`). الأصابع: `HandThumb1/2/3→ThumbMetacarpal/Proximal/Distal`, `HandIndex1/2/3→IndexProximal/Intermediate/Distal`, وMiddle/Ring/Pinky(→Little) بنفس النمط.

**آلة حالة الحركات (المرحلة 4):**
```
idle ──(إرسال رسالة)──▶ thinking ──(وصل الرد+بدأ الصوت)──▶ talking ──(انتهى الصوت)──▶ idle
 │                                                                                      ▲
 └──(زر Dance)──▶ dance ──(Dance ثانية / إرسال رسالة)──────────────────────────────────┘
```
كل انتقال عبر `crossFadeTo(next, 0.4)`. الـ intro (`fall-flat` → `stand-up` → `idle`) يُشغَّل مرة واحدة بعد "Click to start": `LoopOnce` + `clampWhenFinished` + انتظار حدث `finished` من الـ mixer؛ لـ `stand-up` نتخطّى 2.5 ثانية ونشغّله بسرعة 1.6×.

**الرمش (blink):** مؤقّت كل بضع ثوانٍ يحرّك `expressionManager.setValue("blink", ...)` بسرعة.

**المشاعر (المرحلة 4):** `expressionManager.setValue(emotion, ~0.7)` أثناء الحكي، ثم تعود 0 بعد الانتهاء. أسماء VRM 1.0 (تعمل أيضاً لـ VRM 0.x): `happy/angry/sad/relaxed`.

**الصوت و lip sync (المرحلة 3):**
- `AudioContext` واحد؛ `resume()` بعد أول نقرة (المتصفحات تحجب الصوت قبل التفاعل).
- `decodeAudioData(mp3)` ثم `AudioBufferSourceNode` للتشغيل.
- كل إطار: `now = (context.currentTime - startTime - (context.outputLatency||0)) * 1000`؛ نأخذ آخر viseme بـ `time ≤ now` ونضبط الفم (الباقي 0) حسب جدول التحويل:

| viseme | الفم |
|--------|------|
| `a` | aa 1.0 |
| `@` | aa 0.5 |
| `e` | ee 0.8 |
| `E` | ee 0.6 + aa 0.3 |
| `i` | ih 0.8 |
| `o` | oh 0.9 |
| `O` | oh 0.7 + aa 0.3 |
| `u` | ou 0.9 |
| `t`/`s`/`T` | ih 0.3 |
| `S` | ou 0.3 + ih 0.2 |
| `k` | aa 0.3 |
| `r` | ou 0.3 |
| `f` | ih 0.2 |
| غير ذلك | مغلق |

**فقاعة الكلام (المرحلة 3):** عنصر HTML يظهر فوق الشخصية بنص الرد عند بدء الصوت، ويختفي عند انتهائه.

**الواجهة النصية (المرحلة 2):**
- صندوق نص + زر Send؛ Enter يُرسل.
- Send معطّل أثناء انتظار الرد (رد واحد في كل مرة).
- الرسائل تُقص إلى 500 حرف قبل الإرسال.
- عند فشل الخادم: رسالة خطأ قصيرة ودّية + إعادة تفعيل Send للمحاولة ثانية.

### 7. `character.json` (المرحلة 5)

```json
{
  "name": "اسم الكائن الفضائي",
  "avatar": "/avatars/CoolAlien.vrm",
  "voice": { "id": "Matthew", "engine": "neural" },
  "personality": "وصف غني للشخصية (يبقى على السيرفر)",
  "greeting": "جملة ترحيب تُنطق بعد Click to start",
  "background": ["#1a0b2e", "#4b1d6f"]
}
```
- `personality` يُستخدم على السيرفر فقط (system prompt) ولا يُرسل عبر `/character`.
- `background` لونان لتدرّج خلفية CSS.
- `voice.id` معرّف صوت Polly neural (مثل Matthew/Joanna/Ivy/Kevin...).
- بعد "Click to start" (المرحلة 5): يُرسل الـ greeting ليُنطق بنفس مسار Polly.

---

## نماذج البيانات (Data Models)

- **Reply** (Pydantic): `text: str`, `emotion: Literal[...]`.
- **رسالة WS داخلة**: `{type:"user_message", text:str}`.
- **رسالة WS خارجة**: `{type:"reply", text, emotion, audio, visemes[]}` أو `{type:"error", message}`.
- **Viseme**: `{time:int(ms), value:str}`.
- **CharacterConfig** (ملف JSON كما بالأعلى).

---

## معالجة الأخطاء (Error Handling)

| الحالة | المعالجة |
|--------|----------|
| غياب `.env` | `load_dotenv()` لا يفشل؛ boto3 يستخدم IAM role على السيرفر. |
| فشل استدعاء Nova Lite/Polly | يُرسَل `{type:"error"}` برسالة ودّية؛ الواجهة تعيد تفعيل Send. |
| رسالة أطول من 500 حرف | تُقص في الواجهة قبل الإرسال. |
| رسائل متزامنة | Send معطّل حتى يصل الرد (رد واحد في كل مرة). |
| صوت محجوب قبل التفاعل | شاشة "Click to start" + `AudioContext.resume()` بعد النقرة. |
| T-pose / صفحة فارغة | التحقق البصري من المسارات وإعداد VRM (Technical notes). |
| تسريب مفاتيح | المفاتيح لا تُطبع ولا تُرسل للمتصفح؛ `personality` تبقى على السيرفر. |

---

## استراتيجية الاختبار (Testing Strategy)

الاختبار **يدوي عبر المتصفح، مرحلة بمرحلة** — كل مرحلة يجب أن تُرى وتُتحقق قبل التالية:

1. **Task 1 (إعداد):** `uv run uvicorn main:app --reload` يعمل؛ `GET /health` يرد `{"status":"ok"}`؛ `http://localhost:8000` يفتح.
2. **المرحلة 1:** الكائن الفضائي يظهر كامل الجسم يواجه الكاميرا، idle + رمش، "Click to start" ثم intro `fall-flat → stand-up → idle`.
3. **المرحلة 2:** كتابة رسالة → رد نصي بالشخصية، يتذكر المحادثة، ردود قصيرة، Send معطّل أثناء الانتظار، قص 500 حرف، خطأ ودّي عند الفشل.
4. **المرحلة 3:** الرد يُنطق بصوت Polly، الفم متزامن مع الصوت، فقاعة الكلام تظهر وتختفي.
5. **المرحلة 4:** المشاعر تظهر على الوجه أثناء الحكي؛ `thinking` أثناء الانتظار، `talking` أثناء الحكي، `idle` غير ذلك مع crossfades؛ زر Dance يشغّل/يوقف الرقص مع الموسيقى.
6. **المرحلة 5:** عند البدء تُسمع جملة الترحيب؛ الاسم والشخصية والصوت والألوان مخصّصة.

عند أي عطل: تُؤخذ الرسالة الدقيقة من terminal السيرفر أو console المتصفح (F12).

ملاحظة التحقق البصري: المرحلتان 1 و4 تتطلبان تحققاً بصرياً في المتصفح (ظهور الشخصية، الحركات، المشاعر) — لا يكفي قراءة الكود.

---

## خارج النطاق (Out of Scope — لاحقاً)

- **Bonus A:** المايك + Amazon Transcribe streaming (AudioWorklet 16kHz PCM، `aws-sdk-transcribe-streaming`، `--loop asyncio`).
- **Bonus B:** `moves` في character.json واختيار الـ AI للحركة.
- **Bonus C:** أدوات يستدعيها الـ AI (نرد، نتيجة quiz، حقائق)، تأثيرات، حركات Mixamo جديدة، avatar آخر.
- **Bonus D:** النشر على السيرفر عبر SSM (`aws configure` منجز مسبقاً؛ المتبقي fork + push + `deploy`).

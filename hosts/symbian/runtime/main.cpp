#include <QApplication>
#include <QBasicTimer>
#include <QByteArray>
#include <QEvent>
#include <QFile>
#include <QFocusEvent>
#include <QImage>
#include <QKeyEvent>
#include <QLabel>
#include <QList>
#include <QPaintEvent>
#include <QPainter>
#include <QRect>
#include <QResizeEvent>
#include <QSize>
#include <QString>
#include <QTimerEvent>
#include <QTouchEvent>
#include <QVector>
#include <QWidget>

#include <stdint.h>

extern "C" {
#include "quickjs.h"
}

#include "pocketjs_symbian_core.h"

#ifndef POCKETJS_FRAME_RATE
#define POCKETJS_FRAME_RATE 30
#endif

#ifndef POCKETJS_INITIAL_LOGICAL_WIDTH
#define POCKETJS_INITIAL_LOGICAL_WIDTH 480
#endif

#ifndef POCKETJS_INITIAL_LOGICAL_HEIGHT
#define POCKETJS_INITIAL_LOGICAL_HEIGHT 272
#endif

namespace {

const int kMaximumViewportExtent = 640;
const int kTouchCoordinateExtent = 512;
const int kAnalogCenter = 0x8080;
const int kMaximumTouches = 8;

const int kButtonStart = 0x0008;
const int kButtonUp = 0x0010;
const int kButtonRight = 0x0020;
const int kButtonDown = 0x0040;
const int kButtonLeft = 0x0080;
const int kButtonCircle = 0x2000;
const int kButtonCross = 0x4000;

enum HostOperation {
    HostCreateNode,
    HostDestroyNode,
    HostInsertBefore,
    HostRemoveChild,
    HostSetStyle,
    HostSetProp,
    HostSetPropBatch,
    HostSetText,
    HostReplaceText,
    HostUploadTexture,
    HostSetImage,
    HostSetSprite,
    HostAnimate,
    HostCancelAnim,
    HostSetFocus,
    HostSetActive,
    HostHitTest,
    HostSetCursor,
    HostSetCursorPos,
    HostLoadStyles,
    HostLoadFontAtlas,
    HostMeasureText,
    HostFreeTexture,
    HostUploadImgEntry,
    HostDebugInspect,
    HostDebugRectXY,
    HostDebugRectWH,
    HostDebugPause,
    HostDebugStep
};

bool intArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    int32_t *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToInt32(context, value, argv[index]) == 0;
}

bool uintArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    uint32_t *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToUint32(context, value, argv[index]) == 0;
}

bool floatArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    double *value
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    return JS_ToFloat64(context, value, argv[index]) == 0;
}

bool nonNegativeUintArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    uint32_t *value
)
{
    double raw = 0.0;
    if (!floatArgument(context, argc, argv, index, &raw)) return false;
    if (raw <= 0.0) {
        *value = 0;
    } else if (raw >= 4294967295.0) {
        *value = 0xffffffffU;
    } else {
        *value = static_cast<uint32_t>(raw);
    }
    return true;
}

bool stringArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    const char **text,
    size_t *length
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }
    *text = JS_ToCStringLen2(context, length, argv[index], 0);
    return *text != 0;
}

bool bytesArgument(
    JSContext *context,
    int argc,
    JSValueConst *argv,
    int index,
    const uint8_t **data,
    size_t *length
)
{
    if (index >= argc) {
        JS_ThrowTypeError(context, "missing argument %d", index);
        return false;
    }

    uint8_t *direct = JS_GetArrayBuffer(context, length, argv[index]);
    if (!JS_HasException(context)) {
        *data = direct;
        return true;
    }
    JSValue directError = JS_GetException(context);
    JS_FreeValue(context, directError);

    size_t offset = 0;
    size_t byteLength = 0;
    size_t bytesPerElement = 0;
    JSValue buffer = JS_GetTypedArrayBuffer(
        context,
        argv[index],
        &offset,
        &byteLength,
        &bytesPerElement
    );
    if (JS_IsException(buffer)) {
        return false;
    }

    size_t bufferLength = 0;
    uint8_t *base = JS_GetArrayBuffer(context, &bufferLength, buffer);
    if (JS_HasException(context)) {
        JS_FreeValue(context, buffer);
        return false;
    }

    (void)bytesPerElement;
    if (offset > bufferLength || byteLength > bufferLength - offset) {
        JS_FreeValue(context, buffer);
        JS_ThrowRangeError(context, "typed array is outside its backing buffer");
        return false;
    }

    *data = base == 0 ? 0 : base + offset;
    *length = byteLength;
    JS_FreeValue(context, buffer);
    return true;
}

JSValue hostOperation(
    JSContext *context,
    JSValueConst,
    int argc,
    JSValueConst *argv,
    int magic
)
{
    int32_t a = 0;
    int32_t b = 0;
    int32_t c = 0;
    uint32_t ua = 0;
    uint32_t ub = 0;
    uint32_t uc = 0;
    uint32_t ud = 0;
    double da = 0.0;
    double db = 0.0;
    double dc = 0.0;
    double dd = 0.0;
    const uint8_t *bytes = 0;
    size_t byteLength = 0;
    const char *text = 0;
    size_t textLength = 0;

    switch (magic) {
    case HostCreateNode:
        if (!uintArgument(context, argc, argv, 0, &ua)) return JS_EXCEPTION;
        return JS_NewInt32(context, ui_create_node(ua));

    case HostDestroyNode:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_destroy_node(a);
        return JS_UNDEFINED;

    case HostInsertBefore:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b) ||
            !intArgument(context, argc, argv, 2, &c)) {
            return JS_EXCEPTION;
        }
        ui_insert_before(a, b, c);
        return JS_UNDEFINED;

    case HostRemoveChild:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_remove_child(a, b);
        return JS_UNDEFINED;

    case HostSetStyle:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_style(a, b);
        return JS_UNDEFINED;

    case HostSetProp:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !floatArgument(context, argc, argv, 2, &da)) {
            return JS_EXCEPTION;
        }
        ui_set_prop(a, ua, da);
        return JS_UNDEFINED;

    case HostSetPropBatch:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        ui_set_prop_batch(bytes, byteLength);
        return JS_UNDEFINED;

    case HostSetText:
    case HostReplaceText:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !stringArgument(context, argc, argv, 1, &text, &textLength)) {
            return JS_EXCEPTION;
        }
        if (magic == HostSetText) {
            ui_set_text(a, reinterpret_cast<const uint8_t *>(text), textLength);
        } else {
            ui_replace_text(a, reinterpret_cast<const uint8_t *>(text), textLength);
        }
        JS_FreeCString(context, text);
        return JS_UNDEFINED;

    case HostUploadTexture:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !uintArgument(context, argc, argv, 2, &ub) ||
            !uintArgument(context, argc, argv, 3, &uc)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(
            context,
            ui_upload_texture(bytes, byteLength, ua, ub, uc)
        );

    case HostSetImage:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_image(a, b);
        return JS_UNDEFINED;

    case HostSetSprite:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b) ||
            !nonNegativeUintArgument(context, argc, argv, 2, &ua) ||
            !nonNegativeUintArgument(context, argc, argv, 3, &ub) ||
            !nonNegativeUintArgument(context, argc, argv, 4, &uc)) {
            return JS_EXCEPTION;
        }
        ui_set_sprite(a, b, ua, ub, uc);
        return JS_UNDEFINED;

    case HostAnimate:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !uintArgument(context, argc, argv, 1, &ua) ||
            !floatArgument(context, argc, argv, 2, &da) ||
            !nonNegativeUintArgument(context, argc, argv, 3, &ub) ||
            !uintArgument(context, argc, argv, 4, &uc) ||
            !nonNegativeUintArgument(context, argc, argv, 5, &ud)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(context, ui_animate(a, ua, da, ub, uc, ud));

    case HostCancelAnim:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_cancel_anim(a);
        return JS_UNDEFINED;

    case HostSetFocus:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_set_focus(a);
        return JS_UNDEFINED;

    case HostSetActive:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !intArgument(context, argc, argv, 1, &b)) {
            return JS_EXCEPTION;
        }
        ui_set_active(a, b);
        return JS_UNDEFINED;

    case HostHitTest:
        if (!floatArgument(context, argc, argv, 0, &da) ||
            !floatArgument(context, argc, argv, 1, &db)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(
            context,
            ui_hit_test(static_cast<float>(da), static_cast<float>(db))
        );

    case HostSetCursor:
        if (!intArgument(context, argc, argv, 0, &a) ||
            !floatArgument(context, argc, argv, 1, &da) ||
            !floatArgument(context, argc, argv, 2, &db) ||
            !floatArgument(context, argc, argv, 3, &dc) ||
            !floatArgument(context, argc, argv, 4, &dd)) {
            return JS_EXCEPTION;
        }
        ui_set_cursor(
            a,
            static_cast<float>(da),
            static_cast<float>(db),
            static_cast<float>(dc),
            static_cast<float>(dd)
        );
        return JS_UNDEFINED;

    case HostSetCursorPos:
        if (!floatArgument(context, argc, argv, 0, &da) ||
            !floatArgument(context, argc, argv, 1, &db)) {
            return JS_EXCEPTION;
        }
        ui_set_cursor_pos(static_cast<float>(da), static_cast<float>(db));
        return JS_UNDEFINED;

    case HostLoadStyles:
    case HostLoadFontAtlas:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        if (magic == HostLoadStyles) {
            return JS_NewBool(context, ui_load_styles(bytes, byteLength));
        }
        return JS_NewBool(context, ui_load_font_atlas(bytes, byteLength));

    case HostMeasureText:
        if (!stringArgument(context, argc, argv, 0, &text, &textLength)) {
            return JS_EXCEPTION;
        }
        if (!uintArgument(context, argc, argv, 1, &ua)) {
            JS_FreeCString(context, text);
            return JS_EXCEPTION;
        }
        da = ui_measure_text(
            reinterpret_cast<const uint8_t *>(text),
            textLength,
            ua
        );
        JS_FreeCString(context, text);
        return JS_NewFloat64(context, da);

    case HostFreeTexture:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_free_texture(a);
        return JS_UNDEFINED;

    case HostUploadImgEntry:
        if (!bytesArgument(
                context, argc, argv, 0, &bytes, &byteLength)) {
            return JS_EXCEPTION;
        }
        return JS_NewInt32(context, ui_upload_img_entry(bytes, byteLength));

    case HostDebugInspect:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_debug_inspect(a);
        return JS_UNDEFINED;

    case HostDebugRectXY:
        return JS_NewInt32(context, ui_debug_rect_xy());

    case HostDebugRectWH:
        return JS_NewInt32(context, ui_debug_rect_wh());

    case HostDebugPause:
        if (!intArgument(context, argc, argv, 0, &a)) return JS_EXCEPTION;
        ui_debug_pause(a);
        return JS_UNDEFINED;

    case HostDebugStep:
        ui_debug_step();
        return JS_UNDEFINED;
    }

    return JS_ThrowInternalError(context, "unknown PocketJS HostOp");
}

void addHostOperation(
    JSContext *context,
    JSValueConst object,
    const char *name,
    int arity,
    HostOperation operation
)
{
    JSValue function = JS_NewCFunctionMagic(
        context,
        hostOperation,
        name,
        arity,
        JS_CFUNC_generic_magic,
        static_cast<int>(operation)
    );
    JS_SetPropertyStr(context, object, name, function);
}

bool installHostOps(
    JSContext *context,
    JSValueConst global,
    int viewportWidth,
    int viewportHeight
)
{
    JSValue ui = JS_NewObject(context);
    if (JS_IsException(ui)) return false;

    addHostOperation(context, ui, "createNode", 1, HostCreateNode);
    addHostOperation(context, ui, "destroyNode", 1, HostDestroyNode);
    addHostOperation(context, ui, "insertBefore", 3, HostInsertBefore);
    addHostOperation(context, ui, "removeChild", 2, HostRemoveChild);
    addHostOperation(context, ui, "setStyle", 2, HostSetStyle);
    addHostOperation(context, ui, "setProp", 3, HostSetProp);
    addHostOperation(context, ui, "setPropBatch", 1, HostSetPropBatch);
    addHostOperation(context, ui, "setText", 2, HostSetText);
    addHostOperation(context, ui, "replaceText", 2, HostReplaceText);
    addHostOperation(context, ui, "uploadTexture", 4, HostUploadTexture);
    addHostOperation(context, ui, "setImage", 2, HostSetImage);
    addHostOperation(context, ui, "setSprite", 5, HostSetSprite);
    addHostOperation(context, ui, "animate", 6, HostAnimate);
    addHostOperation(context, ui, "cancelAnim", 1, HostCancelAnim);
    addHostOperation(context, ui, "setFocus", 1, HostSetFocus);
    addHostOperation(context, ui, "setActive", 2, HostSetActive);
    addHostOperation(context, ui, "hitTest", 2, HostHitTest);
    addHostOperation(context, ui, "setCursor", 5, HostSetCursor);
    addHostOperation(context, ui, "setCursorPos", 2, HostSetCursorPos);
    addHostOperation(context, ui, "loadStyles", 1, HostLoadStyles);
    addHostOperation(context, ui, "loadFontAtlas", 1, HostLoadFontAtlas);
    addHostOperation(context, ui, "measureText", 2, HostMeasureText);
    addHostOperation(context, ui, "freeTexture", 1, HostFreeTexture);
    addHostOperation(context, ui, "uploadImgEntry", 1, HostUploadImgEntry);
    addHostOperation(context, ui, "debugInspect", 1, HostDebugInspect);
    addHostOperation(context, ui, "debugRectXY", 0, HostDebugRectXY);
    addHostOperation(context, ui, "debugRectWH", 0, HostDebugRectWH);
    addHostOperation(context, ui, "debugPause", 1, HostDebugPause);
    addHostOperation(context, ui, "debugStep", 0, HostDebugStep);

    JSValue viewport = JS_NewObject(context);
    JS_SetPropertyStr(
        context,
        viewport,
        "w",
        JS_NewInt32(context, viewportWidth)
    );
    JS_SetPropertyStr(
        context,
        viewport,
        "h",
        JS_NewInt32(context, viewportHeight)
    );
    JS_SetPropertyStr(context, ui, "__viewport", viewport);

    JS_SetPropertyStr(
        context,
        ui,
        "__host",
        JS_NewString(context, "symbian-e7-dev")
    );
    JS_SetPropertyStr(context, ui, "__hostAbi", JS_NewInt32(context, 1));

    // Deliberately publish neither __textures nor __sprites. The target-bound
    // native host still feeds styles, fonts, and images through global __pak.
    return JS_SetPropertyStr(context, global, "ui", ui) >= 0;
}

int buttonForKey(int key)
{
    switch (key) {
    case Qt::Key_Up:
        return kButtonUp;
    case Qt::Key_Right:
        return kButtonRight;
    case Qt::Key_Down:
        return kButtonDown;
    case Qt::Key_Left:
        return kButtonLeft;
    case Qt::Key_Select:
    case Qt::Key_Return:
    case Qt::Key_Enter:
        return kButtonCircle;
    case Qt::Key_Escape:
        return kButtonCross;
    case Qt::Key_Space:
        return kButtonStart;
    default:
        return 0;
    }
}

} // namespace

class PocketJsRuntime : public QWidget
{
public:
    PocketJsRuntime();
    ~PocketJsRuntime();

protected:
    bool event(QEvent *event);
    void keyPressEvent(QKeyEvent *event);
    void keyReleaseEvent(QKeyEvent *event);
    void focusOutEvent(QFocusEvent *event);
    void paintEvent(QPaintEvent *event);
    void resizeEvent(QResizeEvent *event);
    void timerEvent(QTimerEvent *event);

private:
    bool initialize(const QSize &viewport);
    bool applyPendingViewport();
    bool loadResource(const QString &path, QByteArray *bytes);
    bool drainJobs();
    bool validViewport(const QSize &viewport) const;
    QString takeException(JSContext *context);
    void fail(const QString &message);
    void queueViewport(const QSize &viewport);
    void runFrame();
    void updateTouches(QTouchEvent *event);

    JSRuntime *runtime_;
    JSContext *context_;
    JSValue global_;
    JSValue frame_;
    JSValue resizeViewport_;
    QByteArray appJavaScript_;
    QByteArray appPack_;
    QImage framebuffer_;
    QBasicTimer timer_;
    QLabel *errorLabel_;
    QVector<uint32_t> touches_;
    QSize viewportSize_;
    QSize pendingViewportSize_;
    int buttons_;
    bool coreInitialized_;
    bool initialized_;
    bool hasPendingViewport_;
    bool failed_;
};

PocketJsRuntime::PocketJsRuntime()
    : QWidget(0),
      runtime_(0),
      context_(0),
      global_(JS_UNDEFINED),
      frame_(JS_UNDEFINED),
      resizeViewport_(JS_UNDEFINED),
      errorLabel_(new QLabel(this)),
      pendingViewportSize_(
          POCKETJS_INITIAL_LOGICAL_WIDTH,
          POCKETJS_INITIAL_LOGICAL_HEIGHT
      ),
      buttons_(0),
      coreInitialized_(false),
      initialized_(false),
      hasPendingViewport_(true),
      failed_(false)
{
    setAttribute(Qt::WA_OpaquePaintEvent, true);
    setAttribute(Qt::WA_AcceptTouchEvents, true);
    setAttribute(Qt::WA_AutoOrientation, true);
    setFocusPolicy(Qt::StrongFocus);

    errorLabel_->setAlignment(Qt::AlignCenter);
    errorLabel_->setWordWrap(true);
    errorLabel_->setTextFormat(Qt::PlainText);
    errorLabel_->setStyleSheet(
        "QLabel {"
        " background: #250d12;"
        " color: #fff4f4;"
        " font-size: 18px;"
        " padding: 24px;"
        "}"
    );
    errorLabel_->hide();

    // QApplication::exec() starts only after main() calls showFullScreen().
    // The first timer event therefore observes the native fullscreen extent
    // instead of QWidget's pre-show default geometry.
    const int interval = qMax(1, 1000 / POCKETJS_FRAME_RATE);
    timer_.start(interval, this);
}

PocketJsRuntime::~PocketJsRuntime()
{
    timer_.stop();
    if (context_ != 0) {
        JS_FreeValue(context_, resizeViewport_);
        JS_FreeValue(context_, frame_);
        JS_FreeValue(context_, global_);
        JS_FreeContext(context_);
        context_ = 0;
    }
    if (runtime_ != 0) {
        JS_FreeRuntime(runtime_);
        runtime_ = 0;
    }
    if (coreInitialized_) {
        // QImage borrows the Rust framebuffer without a cleanup callback.
        // Release that view before ui_shutdown() drops the backing storage.
        framebuffer_ = QImage();
        ui_shutdown();
        coreInitialized_ = false;
    }
}

bool PocketJsRuntime::loadResource(
    const QString &path,
    QByteArray *bytes
)
{
    QFile file(path);
    if (!file.open(QIODevice::ReadOnly)) {
        fail(QString("PocketJS resource is missing:\n%1").arg(path));
        return false;
    }
    *bytes = file.readAll();
    return true;
}

bool PocketJsRuntime::validViewport(const QSize &viewport) const
{
    return viewport.width() > 0 &&
        viewport.height() > 0 &&
        viewport.width() <= kMaximumViewportExtent &&
        viewport.height() <= kMaximumViewportExtent;
}

bool PocketJsRuntime::initialize(const QSize &viewport)
{
    if (!validViewport(viewport)) {
        fail(
            QString("PocketJS received an invalid initial viewport: %1x%2")
                .arg(viewport.width())
                .arg(viewport.height())
        );
        return false;
    }

    viewportSize_ = viewport;
    pendingViewportSize_ = viewport;
    hasPendingViewport_ = false;

    ui_init(1);
    coreInitialized_ = true;
    ui_set_viewport(viewport.width(), viewport.height());

    if (!loadResource(":/pocketjs/app.js", &appJavaScript_) ||
        !loadResource(":/pocketjs/app.pak", &appPack_)) {
        return false;
    }
    if (appJavaScript_.isEmpty()) {
        fail(":/pocketjs/app.js is empty");
        return false;
    }

    runtime_ = JS_NewRuntime();
    if (runtime_ == 0) {
        fail("QuickJS runtime allocation failed");
        return false;
    }
    JS_SetMaxStackSize(runtime_, 512 * 1024);

    context_ = JS_NewContext(runtime_);
    if (context_ == 0) {
        fail("QuickJS context allocation failed");
        return false;
    }
    global_ = JS_GetGlobalObject(context_);

    if (!installHostOps(
            context_,
            global_,
            viewport.width(),
            viewport.height())) {
        fail(takeException(context_));
        return false;
    }

    JSValue pack = JS_NewArrayBuffer(
        context_,
        reinterpret_cast<uint8_t *>(appPack_.data()),
        static_cast<size_t>(appPack_.size()),
        0,
        0,
        0
    );
    if (JS_IsException(pack) ||
        JS_SetPropertyStr(context_, global_, "__pak", pack) < 0 ||
        JS_SetPropertyStr(
            context_,
            global_,
            "__simHz",
            JS_NewInt32(context_, POCKETJS_FRAME_RATE)
        ) < 0) {
        fail(takeException(context_));
        return false;
    }

    JSValue result = JS_Eval(
        context_,
        appJavaScript_.constData(),
        static_cast<size_t>(appJavaScript_.size()),
        "app.js",
        JS_EVAL_TYPE_GLOBAL
    );
    if (JS_IsException(result)) {
        fail(takeException(context_));
        return false;
    }
    JS_FreeValue(context_, result);

    frame_ = JS_GetPropertyStr(context_, global_, "frame");
    if (JS_IsException(frame_)) {
        fail(takeException(context_));
        return false;
    }
    if (!JS_IsFunction(context_, frame_)) {
        fail("app.js did not install globalThis.frame");
        return false;
    }

    resizeViewport_ = JS_GetPropertyStr(
        context_,
        global_,
        "__pocketResizeViewport"
    );
    if (JS_IsException(resizeViewport_)) {
        fail(takeException(context_));
        return false;
    }
    if (!JS_IsFunction(context_, resizeViewport_)) {
        fail("app.js did not install globalThis.__pocketResizeViewport");
        return false;
    }

    initialized_ = true;
    return true;
}

QString PocketJsRuntime::takeException(JSContext *context)
{
    if (context == 0) return "Unknown QuickJS failure";

    JSValue exception = JS_GetException(context);
    size_t messageLength = 0;
    const char *message = JS_ToCStringLen2(
        context,
        &messageLength,
        exception,
        0
    );
    QString text = message == 0
        ? QString("QuickJS exception")
        : QString::fromUtf8(message, static_cast<int>(messageLength));
    if (message != 0) JS_FreeCString(context, message);

    if (JS_IsError(context, exception)) {
        JSValue stack = JS_GetPropertyStr(context, exception, "stack");
        if (!JS_IsException(stack) && !JS_IsUndefined(stack)) {
            size_t stackLength = 0;
            const char *stackText = JS_ToCStringLen2(
                context,
                &stackLength,
                stack,
                0
            );
            if (stackText != 0) {
                const QString formatted = QString::fromUtf8(
                    stackText,
                    static_cast<int>(stackLength)
                );
                if (!formatted.isEmpty() && formatted != text) {
                    text += "\n\n" + formatted;
                }
                JS_FreeCString(context, stackText);
            }
        }
        JS_FreeValue(context, stack);
    }
    JS_FreeValue(context, exception);
    return text;
}

void PocketJsRuntime::fail(const QString &message)
{
    if (failed_) return;
    failed_ = true;
    timer_.stop();
    errorLabel_->setText(
        QString("PocketJS E7 runtime stopped\n\n%1").arg(message)
    );
    errorLabel_->setGeometry(rect());
    errorLabel_->show();
    errorLabel_->raise();
    repaint();
}

bool PocketJsRuntime::drainJobs()
{
    JSContext *jobContext = 0;
    int result = 0;
    while ((result = JS_ExecutePendingJob(runtime_, &jobContext)) > 0) {
    }
    if (result < 0) {
        fail(takeException(jobContext == 0 ? context_ : jobContext));
        return false;
    }
    return true;
}

void PocketJsRuntime::queueViewport(const QSize &viewport)
{
    // Symbian can report a transient empty extent while changing layout.
    // Wait for the final non-empty QWidget size rather than resizing the core
    // to a geometry it cannot render.
    if (viewport.width() <= 0 || viewport.height() <= 0) return;

    if (initialized_ && viewport == viewportSize_) {
        pendingViewportSize_ = viewport;
        hasPendingViewport_ = false;
        return;
    }
    if (hasPendingViewport_ && viewport == pendingViewportSize_) return;

    pendingViewportSize_ = viewport;
    hasPendingViewport_ = true;

    // Coordinates and held keyboard directions belong to the old screen
    // orientation. Never deliver them against the replacement layout.
    buttons_ = 0;
    touches_.clear();
}

bool PocketJsRuntime::applyPendingViewport()
{
    if (!hasPendingViewport_) return true;

    const QSize viewport = pendingViewportSize_;
    hasPendingViewport_ = false;
    if (viewport == viewportSize_) return true;
    if (!validViewport(viewport)) {
        fail(
            QString("PocketJS received an invalid viewport: %1x%2")
                .arg(viewport.width())
                .arg(viewport.height())
        );
        return false;
    }

    // framebuffer_ borrows the Rust Vec returned by ui_render_incremental().
    // Drop that QImage view before ui_set_viewport() clears/reallocates it.
    framebuffer_ = QImage();
    ui_set_viewport(viewport.width(), viewport.height());
    viewportSize_ = viewport;
    buttons_ = 0;
    touches_.clear();

    JSValue arguments[2];
    arguments[0] = JS_NewInt32(context_, viewport.width());
    arguments[1] = JS_NewInt32(context_, viewport.height());
    JSValue result = JS_Call(
        context_,
        resizeViewport_,
        global_,
        2,
        arguments
    );
    JS_FreeValue(context_, arguments[0]);
    JS_FreeValue(context_, arguments[1]);
    if (JS_IsException(result)) {
        fail(takeException(context_));
        return false;
    }
    JS_FreeValue(context_, result);
    if (!drainJobs()) return false;

    update();
    return true;
}

void PocketJsRuntime::runFrame()
{
    JSValue touchArray = JS_NewArray(context_);
    for (int index = 0; index < touches_.size(); ++index) {
        JS_SetPropertyUint32(
            context_,
            touchArray,
            static_cast<uint32_t>(index),
            JS_NewUint32(context_, touches_.at(index))
        );
    }

    JSValue arguments[3];
    arguments[0] = JS_NewInt32(context_, buttons_);
    arguments[1] = JS_NewInt32(context_, kAnalogCenter);
    arguments[2] = touchArray;
    JSValue result = JS_Call(
        context_,
        frame_,
        global_,
        3,
        arguments
    );
    JS_FreeValue(context_, arguments[0]);
    JS_FreeValue(context_, arguments[1]);
    JS_FreeValue(context_, touchArray);

    if (JS_IsException(result)) {
        fail(takeException(context_));
        return;
    }
    JS_FreeValue(context_, result);
    if (!drainJobs()) return;

    ui_tick();
    ui_tick();
    const uint8_t *pixels = ui_render_incremental();
    const uint32_t width = ui_framebuffer_width();
    const uint32_t height = ui_framebuffer_height();
    const uint32_t stride = ui_framebuffer_stride();
    const size_t length = ui_framebuffer_len();
    if (pixels == 0 ||
        width != static_cast<uint32_t>(viewportSize_.width()) ||
        height != static_cast<uint32_t>(viewportSize_.height()) ||
        stride < width * 4 ||
        length < static_cast<size_t>(stride) * height) {
        fail(
            QString("PocketJS core returned an invalid %1x%2 framebuffer")
                .arg(viewportSize_.width())
                .arg(viewportSize_.height())
        );
        return;
    }

    framebuffer_ = QImage(
        reinterpret_cast<const uchar *>(pixels),
        static_cast<int>(width),
        static_cast<int>(height),
        static_cast<int>(stride),
        QImage::Format_ARGB32
    );
    repaint();
}

void PocketJsRuntime::updateTouches(QTouchEvent *touchEvent)
{
    touches_.clear();

    // The current public frame wire has 9-bit x/y fields. A 640px E7
    // viewport cannot be represented without truncation, so do not publish
    // touch contacts until the framework negotiates the wider wire. The
    // target profile intentionally does not advertise input.touch.
    if (!initialized_ ||
        hasPendingViewport_ ||
        size() != viewportSize_ ||
        viewportSize_.width() > kTouchCoordinateExtent ||
        viewportSize_.height() > kTouchCoordinateExtent) {
        return;
    }

    const QRect target = rect();

    const QList<QTouchEvent::TouchPoint> points = touchEvent->touchPoints();
    for (int index = 0;
         index < points.size() && touches_.size() < kMaximumTouches;
         ++index) {
        const QTouchEvent::TouchPoint &point = points.at(index);
        if (point.state() == Qt::TouchPointReleased) continue;

        const QPointF position = point.pos();
        if (position.x() < target.left() ||
            position.x() >= target.left() + target.width() ||
            position.y() < target.top() ||
            position.y() >= target.top() + target.height()) {
            continue;
        }
        int x = static_cast<int>(position.x() - target.left());
        int y = static_cast<int>(position.y() - target.top());
        x = qBound(0, x, viewportSize_.width() - 1);
        y = qBound(0, y, viewportSize_.height() - 1);
        const uint32_t packed =
            ((static_cast<uint32_t>(point.id()) & 0xff) << 18) |
            ((static_cast<uint32_t>(y) & 0x1ff) << 9) |
            (static_cast<uint32_t>(x) & 0x1ff);
        touches_.append(packed);
    }
}

bool PocketJsRuntime::event(QEvent *event)
{
    if (event->type() == QEvent::TouchBegin ||
        event->type() == QEvent::TouchUpdate ||
        event->type() == QEvent::TouchEnd) {
        updateTouches(static_cast<QTouchEvent *>(event));
        event->accept();
        return true;
    }
    return QWidget::event(event);
}

void PocketJsRuntime::keyPressEvent(QKeyEvent *event)
{
    const int button = buttonForKey(event->key());
    if (button != 0) {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        buttons_ |= button;
        event->accept();
        return;
    }
    QWidget::keyPressEvent(event);
}

void PocketJsRuntime::keyReleaseEvent(QKeyEvent *event)
{
    const int button = buttonForKey(event->key());
    if (button != 0) {
        if (event->isAutoRepeat()) {
            event->accept();
            return;
        }
        buttons_ &= ~button;
        event->accept();
        return;
    }
    QWidget::keyReleaseEvent(event);
}

void PocketJsRuntime::focusOutEvent(QFocusEvent *event)
{
    buttons_ = 0;
    touches_.clear();
    QWidget::focusOutEvent(event);
}

void PocketJsRuntime::paintEvent(QPaintEvent *)
{
    QPainter painter(this);
    painter.fillRect(rect(), Qt::black);
    if (!framebuffer_.isNull() && !failed_) {
        painter.setRenderHint(QPainter::SmoothPixmapTransform, false);
        painter.drawImage(0, 0, framebuffer_);
    }
}

void PocketJsRuntime::resizeEvent(QResizeEvent *event)
{
    queueViewport(event->size());
    errorLabel_->setGeometry(rect());
    QWidget::resizeEvent(event);
}

void PocketJsRuntime::timerEvent(QTimerEvent *event)
{
    if (event->timerId() == timer_.timerId()) {
        if (failed_) return;

        // QResizeEvent is authoritative; polling size() is a cheap fallback
        // for Belle variants that coalesce a native layout notification.
        queueViewport(size());

        if (!initialized_) {
            if (!isVisible() || !isFullScreen() || !validViewport(size())) {
                return;
            }
            if (!initialize(size())) return;
        }

        if (!applyPendingViewport()) return;
        runFrame();
        return;
    }
    QWidget::timerEvent(event);
}

int main(int argc, char *argv[])
{
    QApplication application(argc, argv);
    PocketJsRuntime runtime;
    runtime.showFullScreen();
    runtime.setFocus();
    return application.exec();
}

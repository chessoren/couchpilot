package com.couchpilot.tv

import android.Manifest
import android.annotation.SuppressLint
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.speech.RecognitionListener
import android.speech.RecognizerIntent
import android.speech.SpeechRecognizer
import android.speech.tts.TextToSpeech
import android.view.KeyEvent
import android.view.WindowManager
import android.webkit.JavascriptInterface
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.WebViewAssetLoader
import org.json.JSONObject
import java.util.Locale

/**
 * Couch Pilot for Fire OS.
 *
 * Hosts the Couch Pilot TV app (bundled from /web) in a full-screen WebView and
 * connects it to the Fire TV remote, the microphone (Android SpeechRecognizer)
 * and the system text-to-speech engine.
 *
 * Remote mapping:
 *   D-pad / Select  -> navigate and press
 *   Menu (☰)        -> talk to Couch Pilot
 *   Back            -> stop the agent instantly / go back
 *   Play/Pause      -> play / pause
 *
 * Standalone by default (on-device planner). To connect the TV to a Couch Pilot
 * server (MCP / Alexa+ mode), start it with:
 *   adb shell am start -n com.couchpilot.tv/.MainActivity --es server http://192.168.1.20:8787
 */
class MainActivity : Activity(), TextToSpeech.OnInitListener {

    private lateinit var web: WebView
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private var recognizer: SpeechRecognizer? = null

    @SuppressLint("SetJavaScriptEnabled")
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

        val assets = WebViewAssetLoader.Builder()
            .addPathHandler("/assets/", WebViewAssetLoader.AssetsPathHandler(this))
            .build()

        web = WebView(this).apply {
            settings.javaScriptEnabled = true
            settings.domStorageEnabled = true
            settings.mediaPlaybackRequiresUserGesture = false
            settings.mixedContentMode = android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW
            isFocusable = true
            isFocusableInTouchMode = true
            setBackgroundColor(0xFF8F8A83.toInt())
            addJavascriptInterface(Bridge(), "CouchPilotAndroid")
            webViewClient = object : WebViewClient() {
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                    assets.shouldInterceptRequest(request.url)
            }
        }
        setContentView(web)
        web.requestFocus()

        tts = TextToSpeech(this, this)

        val server = intent?.getStringExtra("server")
        web.loadUrl(
            if (server.isNullOrBlank()) "https://appassets.androidplatform.net/assets/index.html?offline"
            else server.trimEnd('/') + "/"
        )
    }

    override fun onInit(status: Int) {
        if (status == TextToSpeech.SUCCESS) {
            tts?.language = Locale.US
            tts?.setSpeechRate(0.95f)
            ttsReady = true
        }
    }

    private fun js(code: String) = runOnUiThread { web.evaluateJavascript(code, null) }

    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (event.action == KeyEvent.ACTION_DOWN) {
            when (event.keyCode) {
                KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SEARCH -> { js("window.couchPilot && couchPilot.key('M')"); return true }
                KeyEvent.KEYCODE_BACK -> { js("window.couchPilot && couchPilot.back()"); return true }
                KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE -> { js("window.couchPilot && couchPilot.key('MediaPlayPause')"); return true }
                KeyEvent.KEYCODE_MEDIA_REWIND -> { js("window.couchPilot && couchPilot.ask('go back 10 seconds')"); return true }
                KeyEvent.KEYCODE_MEDIA_FAST_FORWARD -> { js("window.couchPilot && couchPilot.ask('skip ahead 10 seconds')"); return true }
            }
        }
        if (event.action == KeyEvent.ACTION_UP &&
            event.keyCode in listOf(KeyEvent.KEYCODE_MENU, KeyEvent.KEYCODE_SEARCH, KeyEvent.KEYCODE_BACK)) return true
        return super.dispatchKeyEvent(event)
    }

    /** Called from JavaScript as window.CouchPilotAndroid.* */
    inner class Bridge {
        @JavascriptInterface
        fun speak(text: String) {
            if (ttsReady) tts?.speak(text, TextToSpeech.QUEUE_FLUSH, null, "couchpilot")
        }

        @JavascriptInterface
        fun startListening() = runOnUiThread { listen() }
    }

    private fun listen() {
        if (!SpeechRecognizer.isRecognitionAvailable(this)) {
            // Many Fire TV models reserve the voice pipeline for Alexa: fall back to typing.
            js("couchPilot.onVoiceError()")
            return
        }
        if (Build.VERSION.SDK_INT >= 23 && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(arrayOf(Manifest.permission.RECORD_AUDIO), 7)
            return
        }
        recognizer?.destroy()
        recognizer = SpeechRecognizer.createSpeechRecognizer(this).apply {
            setRecognitionListener(object : RecognitionListener {
                override fun onPartialResults(b: Bundle) = deliver(b, false)
                override fun onResults(b: Bundle) = deliver(b, true)
                override fun onError(error: Int) = js("couchPilot.onVoiceError()")
                override fun onReadyForSpeech(p: Bundle?) {}
                override fun onBeginningOfSpeech() {}
                override fun onRmsChanged(v: Float) {}
                override fun onBufferReceived(b: ByteArray?) {}
                override fun onEndOfSpeech() {}
                override fun onEvent(t: Int, p: Bundle?) {}
            })
            startListening(Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
                putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
                putExtra(RecognizerIntent.EXTRA_LANGUAGE, "en-US")
                putExtra(RecognizerIntent.EXTRA_PARTIAL_RESULTS, true)
            })
        }
    }

    private fun deliver(b: Bundle, final: Boolean) {
        val text = b.getStringArrayList(SpeechRecognizer.RESULTS_RECOGNITION)?.firstOrNull() ?: return
        js("couchPilot.onVoiceResult(${JSONObject.quote(text)}, $final)")
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode == 7 && grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) listen()
        else js("couchPilot.onVoiceError()")
    }

    override fun onDestroy() {
        recognizer?.destroy()
        tts?.shutdown()
        web.destroy()
        super.onDestroy()
    }
}

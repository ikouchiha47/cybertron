package com.doorcam.app

import com.facebook.react.uimanager.SimpleViewManager
import com.facebook.react.uimanager.ThemedReactContext
import com.facebook.react.uimanager.annotations.ReactProp

class MjpegStreamViewManager : SimpleViewManager<MjpegStreamView>() {

    override fun getName() = "MjpegStreamView"

    override fun createViewInstance(context: ThemedReactContext): MjpegStreamView {
        return MjpegStreamView(context)
    }

    @ReactProp(name = "url")
    fun setUrl(view: MjpegStreamView, url: String?) {
        if (url.isNullOrEmpty()) {
            view.stopStream()
        } else {
            view.startStream(url)
        }
    }

    @ReactProp(name = "streamId")
    fun setStreamId(view: MjpegStreamView, id: String?) {
        view.streamId = id ?: "default"
    }

    @ReactProp(name = "detectionEnabled", defaultBoolean = true)
    fun setDetectionEnabled(view: MjpegStreamView, enabled: Boolean) {
        view.detectionEnabled = enabled
    }

    @ReactProp(name = "inferenceIntervalMs")
    fun setInferenceInterval(view: MjpegStreamView, ms: Int) {
        // Update the live emission cadence without restarting the stream.
        view.setInferenceInterval(ms.toLong())
    }

    override fun onDropViewInstance(view: MjpegStreamView) {
        view.stopStream()
        super.onDropViewInstance(view)
    }
}

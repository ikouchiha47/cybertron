package com.doorcam.app

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat

/**
 * Keeps the process alive (and out of the cached-app freezer / Doze) so the
 * JS day/night scheduler keeps running with the screen off. Without this the
 * OS suspends the whole app overnight, the boundary timer never fires at
 * dawn/dusk, and the camera is left on the wrong profile (e.g. the night
 * exposure locked into daylight -> fully washed-out frames).
 *
 * A foreground service is the one mechanism Android does not freeze, so the
 * existing in-app timer + AppState recheck keep working around the clock.
 */
class DoorCamForegroundService : Service() {

  companion object {
    private const val CHANNEL_ID = "doorcam-service"
    private const val NOTIFICATION_ID = 42001

    fun start(context: Context) {
      val intent = Intent(context, DoorCamForegroundService::class.java)
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        context.startForegroundService(intent)
      } else {
        context.startService(intent)
      }
    }
  }

  override fun onCreate() {
    super.onCreate()
    val nm = getSystemService(NotificationManager::class.java)
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
      val channel = NotificationChannel(
        CHANNEL_ID,
        "DoorCam service",
        NotificationManager.IMPORTANCE_MIN,
      ).apply { setShowBadge(false) }
      nm.createNotificationChannel(channel)
    }
  }

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val launch = PendingIntent.getActivity(
      this,
      0,
      Intent(this, MainActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP),
      PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )
    val notification: Notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setContentTitle("DoorCam")
      .setContentText("Watching day/night schedule")
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setOngoing(true)
      .setPriority(NotificationCompat.PRIORITY_MIN)
      .setContentIntent(launch)
      .build()
    startForeground(NOTIFICATION_ID, notification)
    return START_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null
}

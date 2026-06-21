import { useEffect } from 'react'
import { HubConnectionBuilder } from '@microsoft/signalr'

export interface StepStartedEvent {
  deliveryId: string
  stepId: string
  stepName: string
  startedAt: string
}

export interface StepCompletedEvent {
  deliveryId: string
  stepId: string
  stepName: string
  output?: string
  completedAt: string
}

export interface StepFailedEvent {
  deliveryId: string
  stepId: string
  stepName: string
  error: string
  failedAt: string
}

export interface GateReachedEvent {
  deliveryId: string
  stepId: string
  stepName: string
  message: string
}

export interface DeliveryCompletedEvent {
  deliveryId: string
  completedAt: string
  duration: string
}

export interface DeliveryFailedEvent {
  deliveryId: string
  error: string
  failedAt: string
}

export interface GateApprovedEvent {
  deliveryId: string
  stepId: string
  approvedAt: string
}

export interface GateRejectedEvent {
  deliveryId: string
  stepId: string
  reason?: string
  rejectedAt: string
}

export interface DeliveryStatusChangedEvent {
  deliveryId: string
  status: string
  changedAt: string
}

interface SignalRCallbacks {
  onStepStarted?: (event: StepStartedEvent) => void
  onStepCompleted?: (event: StepCompletedEvent) => void
  onStepFailed?: (event: StepFailedEvent) => void
  onGateReached?: (event: GateReachedEvent) => void
  onDeliveryCompleted?: (event: DeliveryCompletedEvent) => void
  onDeliveryFailed?: (event: DeliveryFailedEvent) => void
  onGateApproved?: (event: GateApprovedEvent) => void
  onGateRejected?: (event: GateRejectedEvent) => void
  onDeliveryStatusChanged?: (event: DeliveryStatusChangedEvent) => void
}

export function useSignalR(deliveryId: string | null, callbacks: SignalRCallbacks) {
  useEffect(() => {
    if (!deliveryId) return

    let stopped = false

    async function connect() {
      const baseUrl = await window.axon.settings.get('backendUrl') as Promise<string>

      if (stopped || !baseUrl) return

      const hubUrl = `${baseUrl}/hubs/delivery`

      const connection = new HubConnectionBuilder()
        .withUrl(hubUrl, {
          accessTokenFactory: () =>
            (window.axon.auth.getSecure('axon-access-token') as Promise<string | null>)
              .then((t) => t ?? ''),
        })
        .withAutomaticReconnect()
        .build()

      if (callbacks.onStepStarted) connection.on('StepStarted', callbacks.onStepStarted)
      if (callbacks.onStepCompleted) connection.on('StepCompleted', callbacks.onStepCompleted)
      if (callbacks.onStepFailed) connection.on('StepFailed', callbacks.onStepFailed)
      if (callbacks.onGateReached) connection.on('GateReached', callbacks.onGateReached)
      if (callbacks.onDeliveryCompleted) connection.on('DeliveryCompleted', callbacks.onDeliveryCompleted)
      if (callbacks.onDeliveryFailed) connection.on('DeliveryFailed', callbacks.onDeliveryFailed)
      if (callbacks.onGateApproved) connection.on('GateApproved', callbacks.onGateApproved)
      if (callbacks.onGateRejected) connection.on('GateRejected', callbacks.onGateRejected)
      if (callbacks.onDeliveryStatusChanged) connection.on('DeliveryStatusChanged', callbacks.onDeliveryStatusChanged)

      try {
        await connection.start()
        if (stopped) { connection.stop(); return }
        await connection.invoke('JoinDelivery', deliveryId)
      } catch (e) {
        console.warn('[SignalR] connection failed:', e)
      }

      return connection
    }

    let connectionPromise = connect()

    return () => {
      stopped = true
      connectionPromise.then((conn) => {
        if (!conn) return
        conn.invoke('LeaveDelivery', deliveryId).catch(() => {}).finally(() => conn.stop())
      })
    }
  }, [deliveryId])
}

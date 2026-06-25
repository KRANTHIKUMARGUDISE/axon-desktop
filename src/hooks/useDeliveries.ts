import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query'
import {
  getDeliveries,
  getDelivery,
  createDelivery,
  updateDelivery,
  approveGate,
  rejectGate,
} from '../services/deliveriesService'
import type { DeliveryFilter, CreateDeliveryRequest, UpdateDeliveryRequest } from '../services/deliveriesService'

export function useDeliveries(params?: DeliveryFilter, enabled = true) {
  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['deliveries', params],
    queryFn: () => getDeliveries(params),
    enabled,
    // Same reasoning as useDelivery below — the list's running/paused statuses are live
    // state, not safe to serve from the app-wide 30s stale cache on revisit.
    staleTime: 0,
  })
  return { data, isLoading, isError, error }
}

export function useDelivery(id: string) {
  return useQuery({
    queryKey: ['delivery', id],
    queryFn: () => getDelivery(id),
    enabled: !!id,
    // Deliveries change fast (live execution) and the app-wide default staleTime is 30s
    // (App.tsx) — without overriding it here, navigating away and back to a delivery
    // within that window serves a stale cached snapshot with no fresh network fetch,
    // showing outdated status/steps. DeliveryLiveView's callers already assumed this.
    staleTime: 0,
  })
}

export function useCreateDelivery() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: CreateDeliveryRequest) => createDelivery(data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['deliveries'] })
    },
  })
}

export function useUpdateDelivery(deliveryId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (data: UpdateDeliveryRequest) => updateDelivery(deliveryId, data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delivery', deliveryId] })
    },
  })
}

export function useApproveGate(deliveryId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (comment?: string) => approveGate(deliveryId, comment ? { reason: comment } : undefined),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delivery', deliveryId] })
    },
  })
}

export function useRejectGate(deliveryId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (comment: string) => rejectGate(deliveryId, { reason: comment }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delivery', deliveryId] })
    },
  })
}

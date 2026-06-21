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
  })
  return { data, isLoading, isError, error }
}

export function useDelivery(id: string) {
  return useQuery({
    queryKey: ['delivery', id],
    queryFn: () => getDelivery(id),
    enabled: !!id,
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
    mutationFn: () => approveGate(deliveryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delivery', deliveryId] })
    },
  })
}

export function useRejectGate(deliveryId: string) {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: () => rejectGate(deliveryId),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['delivery', deliveryId] })
    },
  })
}

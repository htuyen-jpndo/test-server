import express from "express";
import { saveFlight, getFlights, getFlightsByPilotId, deleteFlights, getFilteredFlights, getFilteredFlightsByDronePilotDate, resetFlights, updateFlight, deleteFlightById } from "../controllers/flight.controller.js";
import { authMiddleware, adminMiddleware, flightScope, checkFlightOwnerOrAdmin } from "../middlewares/auth.middleware.js";
const router = express.Router();

router.use(authMiddleware);

// Xem flight (scope theo role)
router.get('/', flightScope, getFlights);
router.get('/filter', flightScope, getFilteredFlights);
router.get('/filter-by-pilot', flightScope, getFilteredFlightsByDronePilotDate);
router.get('/by-pilot/:pilotId', flightScope, getFlightsByPilotId);

// User + Admin đều tạo được
router.post('/', saveFlight);

// User sửa/xóa của mình, admin sửa/xóa tất cả
router.patch('/:id', checkFlightOwnerOrAdmin, updateFlight);
router.delete('/:id', checkFlightOwnerOrAdmin, deleteFlightById);

// Chỉ admin
router.delete('/delete', adminMiddleware, deleteFlights);
router.delete('/reset', adminMiddleware, resetFlights);

export default router;
